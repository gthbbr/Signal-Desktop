// Copyright 2017-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-console */

const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const fs = require('fs-extra');
const crypto = require('crypto');
const normalizePath = require('normalize-path');
const fg = require('fast-glob');
const PQueue = require('p-queue').default;

const _ = require('lodash');
const pify = require('pify');
const electron = require('electron');

const packageJson = require('./package.json');
const GlobalErrors = require('./app/global_errors');
const { setup: setupSpellChecker } = require('./app/spell_check');
const { redactAll, addSensitivePath } = require('./ts/util/privacy');
const { strictAssert } = require('./ts/util/assert');
const removeUserConfig = require('./app/user_config').remove;

GlobalErrors.addHandler();

// Set umask early on in the process lifecycle to ensure file permissions are
// set such that only we have read access to our files
process.umask(0o077);

const getRealPath = pify(fs.realpath);
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain: ipc,
  Menu,
  protocol: electronProtocol,
  shell,
  systemPreferences,
} = electron;

const animationSettings = systemPreferences.getAnimationSettings();

const appUserModelId = `org.whispersystems.${packageJson.name}`;
console.log('Set Windows Application User Model ID (AUMID)', {
  appUserModelId,
});
app.setAppUserModelId(appUserModelId);

// We don't navigate, but this is the way of the future
//   https://github.com/electron/electron/issues/18397
// TODO: Make ringrtc-node context-aware and change this to true.
app.allowRendererProcessReuse = false;

// Keep a global reference of the window object, if you don't, the window will
//   be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let mainWindowCreated = false;
let loadingWindow;

function getMainWindow() {
  return mainWindow;
}

const config = require('./app/config').default;

// Very important to put before the single instance check, since it is based on the
//   userData directory.
const userConfig = require('./app/user_config');

const importMode =
  process.argv.some(arg => arg === '--import') || config.get('import');

const development =
  config.environment === 'development' || config.environment === 'staging';

const enableCI = Boolean(config.get('enableCI'));

// We generally want to pull in our own modules after this point, after the user
//   data directory has been set.
const attachments = require('./app/attachments');
const attachmentChannel = require('./app/attachment_channel');
const bounce = require('./ts/services/bounce');
const updater = require('./ts/updater/index');
const { SystemTrayService } = require('./app/SystemTrayService');
const { SystemTraySettingCache } = require('./app/SystemTraySettingCache');
const {
  SystemTraySetting,
  shouldMinimizeToSystemTray,
  parseSystemTraySetting,
} = require('./ts/types/SystemTraySetting');
const ephemeralConfig = require('./app/ephemeral_config');
const logging = require('./ts/logging/main_process_logging');
const { MainSQL } = require('./ts/sql/main');
const sqlChannels = require('./app/sql_channel');
const windowState = require('./app/window_state');
const { createTemplate } = require('./app/menu');
const {
  installFileHandler,
  installWebHandler,
} = require('./app/protocol_filter');
const OS = require('./ts/OS');
const { isProduction } = require('./ts/util/version');
const {
  isSgnlHref,
  isCaptchaHref,
  isSignalHttpsLink,
  parseSgnlHref,
  parseCaptchaHref,
  parseSignalHttpsLink,
} = require('./ts/util/sgnlHref');
const {
  toggleMaximizedBrowserWindow,
} = require('./ts/util/toggleMaximizedBrowserWindow');
const {
  getTitleBarVisibility,
  TitleBarVisibility,
} = require('./ts/types/Settings');
const { Environment, isTestEnvironment } = require('./ts/environment');
const { ChallengeMainHandler } = require('./ts/main/challengeMain');
const { NativeThemeNotifier } = require('./ts/main/NativeThemeNotifier');
const { PowerChannel } = require('./ts/main/powerChannel');
const { SettingsChannel } = require('./ts/main/settingsChannel');
const { maybeParseUrl, setUrlSearchParams } = require('./ts/util/url');
const { getHeicConverter } = require('./ts/workers/heicConverterMain');

const sql = new MainSQL();
const heicConverter = getHeicConverter();

let systemTrayService;
const systemTraySettingCache = new SystemTraySettingCache(
  sql,
  process.argv,
  app.getVersion()
);

const challengeHandler = new ChallengeMainHandler();

const nativeThemeNotifier = new NativeThemeNotifier();
nativeThemeNotifier.initialize();

let sqlInitTimeStart = 0;
let sqlInitTimeEnd = 0;

let appStartInitialSpellcheckSetting = true;

const defaultWebPrefs = {
  devTools:
    process.argv.some(arg => arg === '--enable-dev-tools') ||
    config.environment !== Environment.Production ||
    !isProduction(app.getVersion()),
};

async function getSpellCheckSetting() {
  const fastValue = ephemeralConfig.get('spell-check');
  if (fastValue !== undefined) {
    console.log('got fast spellcheck setting', fastValue);
    return fastValue;
  }

  const json = await sql.sqlCall('getItemById', ['spell-check']);

  // Default to `true` if setting doesn't exist yet
  const slowValue = json ? json.value : true;

  ephemeralConfig.set('spell-check', slowValue);

  console.log('got slow spellcheck setting', slowValue);

  return slowValue;
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  // Using focus() instead of show() seems to be important on Windows when our window
  //   has been docked using Aero Snap/Snap Assist. A full .show() call here will cause
  //   the window to reposition:
  //   https://github.com/signalapp/Signal-Desktop/issues/1429
  if (mainWindow.isVisible()) {
    mainWindow.focus();
  } else {
    mainWindow.show();
  }
}

if (!process.mas) {
  console.log('making app single instance');
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log('quitting; we are the second instance');
    app.exit();
  } else {
    app.on('second-instance', (e, argv) => {
      // Someone tried to run a second instance, we should focus our window
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }

        showWindow();
      }
      const incomingCaptchaHref = getIncomingCaptchaHref(argv);
      if (incomingCaptchaHref) {
        const { captcha } = parseCaptchaHref(incomingCaptchaHref, logger);
        challengeHandler.handleCaptcha(captcha);
        return true;
      }
      // Are they trying to open a sgnl:// href?
      const incomingHref = getIncomingHref(argv);
      if (incomingHref) {
        handleSgnlHref(incomingHref);
      }
      // Handled
      return true;
    });
  }
}

const windowFromUserConfig = userConfig.get('window');
const windowFromEphemeral = ephemeralConfig.get('window');
let windowConfig = windowFromEphemeral || windowFromUserConfig;
if (windowFromUserConfig) {
  userConfig.set('window', null);
  ephemeralConfig.set('window', windowConfig);
}

const loadLocale = require('./app/locale').load;

// Both of these will be set after app fires the 'ready' event
let logger;
let locale;
let settingsChannel;

function prepareFileUrl(
  pathSegments /* : ReadonlyArray<string> */,
  moreKeys /* : undefined | Record<string, unknown> */
) /* : string */ {
  const filePath = path.join(...pathSegments);
  const fileUrl = pathToFileURL(filePath);
  return prepareUrl(fileUrl, moreKeys);
}

function prepareUrl(
  url /* : URL */,
  moreKeys = {} /* : undefined | Record<string, unknown> */
) /* : string */ {
  return setUrlSearchParams(url, {
    name: packageJson.productName,
    locale: locale.name,
    version: app.getVersion(),
    buildCreation: config.get('buildCreation'),
    buildExpiration: config.get('buildExpiration'),
    serverUrl: config.get('serverUrl'),
    storageUrl: config.get('storageUrl'),
    directoryUrl: config.get('directoryUrl'),
    directoryEnclaveId: config.get('directoryEnclaveId'),
    directoryTrustAnchor: config.get('directoryTrustAnchor'),
    cdnUrl0: config.get('cdn').get('0'),
    cdnUrl2: config.get('cdn').get('2'),
    certificateAuthority: config.get('certificateAuthority'),
    environment: enableCI ? 'production' : config.environment,
    enableCI: enableCI ? 'true' : '',
    node_version: process.versions.node,
    hostname: os.hostname(),
    appInstance: process.env.NODE_APP_INSTANCE,
    proxyUrl: process.env.HTTPS_PROXY || process.env.https_proxy,
    contentProxyUrl: config.contentProxyUrl,
    sfuUrl: config.get('sfuUrl'),
    importMode: importMode ? 'true' : '',
    reducedMotionSetting: animationSettings.prefersReducedMotion ? 'true' : '',
    serverPublicParams: config.get('serverPublicParams'),
    serverTrustRoot: config.get('serverTrustRoot'),
    appStartInitialSpellcheckSetting,
    ...moreKeys,
  }).href;
}

async function handleUrl(event, target) {
  event.preventDefault();
  const parsedUrl = maybeParseUrl(target);
  if (!parsedUrl) {
    return;
  }

  const { protocol, hostname } = parsedUrl;
  const isDevServer = config.enableHttp && hostname === 'localhost';
  // We only want to specially handle urls that aren't requesting the dev server
  if (isSgnlHref(target) || isSignalHttpsLink(target)) {
    handleSgnlHref(target);
    return;
  }

  if ((protocol === 'http:' || protocol === 'https:') && !isDevServer) {
    try {
      await shell.openExternal(target);
    } catch (error) {
      console.log(`Failed to open url: ${error.stack}`);
    }
  }
}

function handleCommonWindowEvents(window) {
  window.webContents.on('will-navigate', handleUrl);
  window.webContents.on('new-window', handleUrl);
  window.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error(`Preload error in ${preloadPath}: `, error.message);
  });

  // Works only for mainWindow because it has `enablePreferredSizeMode`
  let lastZoomFactor = window.webContents.getZoomFactor();
  const onZoomChanged = () => {
    const zoomFactor = window.webContents.getZoomFactor();
    if (lastZoomFactor === zoomFactor) {
      return;
    }

    if (window.webContents) {
      window.webContents.send('callbacks:call:persistZoomFactor', [zoomFactor]);
    }

    lastZoomFactor = zoomFactor;
  };
  window.webContents.on('preferred-size-changed', onZoomChanged);

  nativeThemeNotifier.addWindow(window);
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 610;
const MIN_WIDTH = 680;
const MIN_HEIGHT = 550;
const BOUNDS_BUFFER = 100;

function isVisible(window, bounds) {
  const boundsX = _.get(bounds, 'x') || 0;
  const boundsY = _.get(bounds, 'y') || 0;
  const boundsWidth = _.get(bounds, 'width') || DEFAULT_WIDTH;
  const boundsHeight = _.get(bounds, 'height') || DEFAULT_HEIGHT;

  // requiring BOUNDS_BUFFER pixels on the left or right side
  const rightSideClearOfLeftBound =
    window.x + window.width >= boundsX + BOUNDS_BUFFER;
  const leftSideClearOfRightBound =
    window.x <= boundsX + boundsWidth - BOUNDS_BUFFER;

  // top can't be offscreen, and must show at least BOUNDS_BUFFER pixels at bottom
  const topClearOfUpperBound = window.y >= boundsY;
  const topClearOfLowerBound =
    window.y <= boundsY + boundsHeight - BOUNDS_BUFFER;

  return (
    rightSideClearOfLeftBound &&
    leftSideClearOfRightBound &&
    topClearOfUpperBound &&
    topClearOfLowerBound
  );
}

let windowIcon;

if (OS.isWindows()) {
  windowIcon = path.join(__dirname, 'build', 'icons', 'win', 'icon.ico');
} else if (OS.isLinux()) {
  windowIcon = path.join(__dirname, 'images', 'signal-logo-desktop-linux.png');
} else {
  windowIcon = path.join(__dirname, 'build', 'icons', 'png', '512x512.png');
}

async function createWindow() {
  const { screen } = electron;
  const windowOptions = {
    show: false,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    autoHideMenuBar: false,
    titleBarStyle:
      getTitleBarVisibility() === TitleBarVisibility.Hidden &&
      !isTestEnvironment(config.environment)
        ? 'hidden'
        : 'default',
    backgroundColor: isTestEnvironment(config.environment)
      ? '#ffffff' // Tests should always be rendered on a white background
      : '#3a76f0',
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: false,
      enableRemoteModule: true,
      preload: path.join(
        __dirname,
        enableCI || config.environment === 'production'
          ? 'preload.bundle.js'
          : 'preload.js'
      ),
      nativeWindowOpen: true,
      spellcheck: await getSpellCheckSetting(),
      backgroundThrottling: false,
      enablePreferredSizeMode: true,
    },
    icon: windowIcon,
    ..._.pick(windowConfig, ['autoHideMenuBar', 'width', 'height', 'x', 'y']),
  };

  if (!_.isNumber(windowOptions.width) || windowOptions.width < MIN_WIDTH) {
    windowOptions.width = DEFAULT_WIDTH;
  }
  if (!_.isNumber(windowOptions.height) || windowOptions.height < MIN_HEIGHT) {
    windowOptions.height = DEFAULT_HEIGHT;
  }
  if (!_.isBoolean(windowOptions.autoHideMenuBar)) {
    delete windowOptions.autoHideMenuBar;
  }

  const startInTray =
    (await systemTraySettingCache.get()) ===
    SystemTraySetting.MinimizeToAndStartInSystemTray;

  const visibleOnAnyScreen = _.some(screen.getAllDisplays(), display => {
    if (!_.isNumber(windowOptions.x) || !_.isNumber(windowOptions.y)) {
      return false;
    }

    return isVisible(windowOptions, _.get(display, 'bounds'));
  });
  if (!visibleOnAnyScreen) {
    console.log('Location reset needed');
    delete windowOptions.x;
    delete windowOptions.y;
  }

  logger.info(
    'Initializing BrowserWindow config: %s',
    JSON.stringify(windowOptions)
  );

  // Create the browser window.
  mainWindow = new BrowserWindow(windowOptions);
  settingsChannel.setMainWindow(mainWindow);

  mainWindowCreated = true;
  setupSpellChecker(mainWindow, locale.messages);
  if (!startInTray && windowConfig && windowConfig.maximized) {
    mainWindow.maximize();
  }
  if (!startInTray && windowConfig && windowConfig.fullscreen) {
    mainWindow.setFullScreen(true);
  }
  if (systemTrayService) {
    systemTrayService.setMainWindow(mainWindow);
  }

  function captureAndSaveWindowStats() {
    if (!mainWindow) {
      return;
    }

    const size = mainWindow.getSize();
    const position = mainWindow.getPosition();

    // so if we need to recreate the window, we have the most recent settings
    windowConfig = {
      maximized: mainWindow.isMaximized(),
      autoHideMenuBar: mainWindow.autoHideMenuBar,
      fullscreen: mainWindow.isFullScreen(),
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1],
    };

    logger.info(
      'Updating BrowserWindow config: %s',
      JSON.stringify(windowConfig)
    );
    ephemeralConfig.set('window', windowConfig);
  }

  const debouncedCaptureStats = _.debounce(captureAndSaveWindowStats, 500);
  mainWindow.on('resize', debouncedCaptureStats);
  mainWindow.on('move', debouncedCaptureStats);

  const setWindowFocus = () => {
    if (!mainWindow) {
      return;
    }
    mainWindow.webContents.send('set-window-focus', mainWindow.isFocused());
  };
  mainWindow.on('focus', setWindowFocus);
  mainWindow.on('blur', setWindowFocus);
  mainWindow.once('ready-to-show', setWindowFocus);
  // This is a fallback in case we drop an event for some reason.
  setInterval(setWindowFocus, 10000);

  const moreKeys = {
    isFullScreen: String(Boolean(mainWindow.isFullScreen())),
  };

  if (config.environment === 'test') {
    mainWindow.loadURL(
      prepareFileUrl([__dirname, 'test', 'index.html'], moreKeys)
    );
  } else if (config.environment === 'test-lib') {
    mainWindow.loadURL(
      prepareFileUrl(
        [__dirname, 'libtextsecure', 'test', 'index.html'],
        moreKeys
      )
    );
  } else {
    mainWindow.loadURL(
      prepareFileUrl([__dirname, 'background.html'], moreKeys)
    );
  }

  if (!enableCI && config.get('openDevTools')) {
    // Open the DevTools.
    mainWindow.webContents.openDevTools();
  }

  handleCommonWindowEvents(mainWindow);

  // App dock icon bounce
  bounce.init(mainWindow);

  // Emitted when the window is about to be closed.
  // Note: We do most of our shutdown logic here because all windows are closed by
  //   Electron before the app quits.
  mainWindow.on('close', async e => {
    console.log('close event', {
      readyForShutdown: mainWindow ? mainWindow.readyForShutdown : null,
      shouldQuit: windowState.shouldQuit(),
    });
    // If the application is terminating, just do the default
    if (
      isTestEnvironment(config.environment) ||
      (mainWindow.readyForShutdown && windowState.shouldQuit())
    ) {
      return;
    }

    // Prevent the shutdown
    e.preventDefault();

    /**
     * if the user is in fullscreen mode and closes the window, not the
     * application, we need them leave fullscreen first before closing it to
     * prevent a black screen.
     *
     * issue: https://github.com/signalapp/Signal-Desktop/issues/4348
     */

    if (mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', () => mainWindow.hide());
      mainWindow.setFullScreen(false);
    } else {
      mainWindow.hide();
    }

    // On Mac, or on other platforms when the tray icon is in use, the window
    // should be only hidden, not closed, when the user clicks the close button
    const usingTrayIcon = shouldMinimizeToSystemTray(
      await systemTraySettingCache.get()
    );
    if (!windowState.shouldQuit() && (usingTrayIcon || OS.isMacOS())) {
      return;
    }

    await requestShutdown();
    if (mainWindow) {
      mainWindow.readyForShutdown = true;
    }
    await sql.close();
    app.quit();
  });

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = undefined;
    settingsChannel.setMainWindow(mainWindow);
    if (systemTrayService) {
      systemTrayService.setMainWindow(mainWindow);
    }
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('full-screen-change', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('full-screen-change', false);
  });

  mainWindow.once('ready-to-show', async () => {
    console.log('main window is ready-to-show');

    // Ignore sql errors and show the window anyway
    await sqlInitPromise;

    if (!mainWindow) {
      return;
    }

    if (!startInTray) {
      console.log('showing main window');
      mainWindow.show();
    }
  });
}

// Renderer asks if we are done with the database
ipc.on('database-ready', async event => {
  const { error } = await sqlInitPromise;
  if (error) {
    console.log(
      'database-ready requested, but got sql error',
      error && error.stack
    );
    return;
  }

  console.log('sending `database-ready`');
  event.sender.send('database-ready');
});

ipc.on('show-window', () => {
  showWindow();
});

ipc.on('title-bar-double-click', () => {
  if (!mainWindow) {
    return;
  }

  if (OS.isMacOS()) {
    switch (
      systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
    ) {
      case 'Minimize':
        mainWindow.minimize();
        break;
      case 'Maximize':
        toggleMaximizedBrowserWindow(mainWindow);
        break;
      default:
        // If this is disabled, it'll be 'None'. If it's anything else, that's unexpected,
        //   but we'll just no-op.
        break;
    }
  } else {
    // This is currently only supported on macOS. This `else` branch is just here when/if
    //   we add support for other operating systems.
    toggleMaximizedBrowserWindow(mainWindow);
  }
});

ipc.on('convert-image', async (event, uuid, data) => {
  const { error, response } = await heicConverter(uuid, data);
  event.reply(`convert-image:${uuid}`, { error, response });
});

let isReadyForUpdates = false;
async function readyForUpdates() {
  if (isReadyForUpdates) {
    return;
  }

  isReadyForUpdates = true;

  // First, install requested sticker pack
  const incomingHref = getIncomingHref(process.argv);
  if (incomingHref) {
    handleSgnlHref(incomingHref);
  }

  // Second, start checking for app updates
  try {
    await updater.start(getMainWindow, logger);
  } catch (error) {
    logger.error(
      'Error starting update checks:',
      error && error.stack ? error.stack : error
    );
  }
}

async function forceUpdate() {
  try {
    logger.info('starting force update');
    await updater.force();
  } catch (error) {
    logger.error(
      'Error during force update:',
      error && error.stack ? error.stack : error
    );
  }
}

ipc.once('ready-for-updates', readyForUpdates);

const TEN_MINUTES = 10 * 60 * 1000;
setTimeout(readyForUpdates, TEN_MINUTES);

// the support only provides a subset of languages available within the app
// so we have to list them out here and fallback to english if not included

const SUPPORT_LANGUAGES = [
  'ar',
  'bn',
  'de',
  'en-us',
  'es',
  'fr',
  'hi',
  'hi-in',
  'hc',
  'id',
  'it',
  'ja',
  'ko',
  'mr',
  'ms',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'ta',
  'te',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh-cn',
  'zh-tw',
];

function openContactUs() {
  const userLanguage = app.getLocale();
  const language = SUPPORT_LANGUAGES.includes(userLanguage)
    ? userLanguage
    : 'en-us';

  // This URL needs a hardcoded language because the '?desktop' is dropped if the page
  //   auto-redirects to the proper URL
  shell.openExternal(
    `https://support.signal.org/hc/${language}/requests/new?desktop`
  );
}

function openJoinTheBeta() {
  // If we omit the language, the site will detect the language and redirect
  shell.openExternal('https://support.signal.org/hc/articles/360007318471');
}

function openReleaseNotes() {
  shell.openExternal(
    `https://github.com/signalapp/Signal-Desktop/releases/tag/v${app.getVersion()}`
  );
}

function openSupportPage() {
  // If we omit the language, the site will detect the language and redirect
  shell.openExternal('https://support.signal.org/hc/sections/360001602812');
}

function openForums() {
  shell.openExternal('https://community.signalusers.org/');
}

function showKeyboardShortcuts() {
  if (mainWindow) {
    mainWindow.webContents.send('show-keyboard-shortcuts');
  }
}

function setupAsNewDevice() {
  if (mainWindow) {
    mainWindow.webContents.send('set-up-as-new-device');
  }
}

function setupAsStandalone() {
  if (mainWindow) {
    mainWindow.webContents.send('set-up-as-standalone');
  }
}

let screenShareWindow;
function showScreenShareWindow(sourceName) {
  if (screenShareWindow) {
    screenShareWindow.showInactive();
    return;
  }

  const width = 480;

  const { screen } = electron;
  const display = screen.getPrimaryDisplay();
  const options = {
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#2e2e2e',
    darkTheme: true,
    frame: false,
    fullscreenable: false,
    height: 44,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: locale.messages.screenShareWindow.message,
    width,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      preload: path.join(
        __dirname,
        'ts',
        'windows',
        'screenShare',
        'preload.js'
      ),
    },
    x: Math.floor(display.size.width / 2) - width / 2,
    y: 24,
  };

  screenShareWindow = new BrowserWindow(options);

  handleCommonWindowEvents(screenShareWindow);

  screenShareWindow.loadURL(prepareFileUrl([__dirname, 'screenShare.html']));

  screenShareWindow.on('closed', () => {
    screenShareWindow = null;
  });

  screenShareWindow.once('ready-to-show', () => {
    screenShareWindow.showInactive();
    screenShareWindow.webContents.send(
      'render-screen-sharing-controller',
      sourceName
    );
  });
}

let aboutWindow;
function showAbout() {
  if (aboutWindow) {
    aboutWindow.show();
    return;
  }

  const options = {
    width: 500,
    height: 500,
    resizable: false,
    title: locale.messages.aboutSignalDesktop.message,
    autoHideMenuBar: true,
    backgroundColor: '#3a76f0',
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'ts', 'windows', 'about', 'preload.js'),
      nativeWindowOpen: true,
    },
  };

  aboutWindow = new BrowserWindow(options);

  handleCommonWindowEvents(aboutWindow);

  aboutWindow.loadURL(prepareFileUrl([__dirname, 'about.html']));

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });
}

let settingsWindow;
function showSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    return;
  }

  const options = {
    width: 700,
    height: 700,
    frame: true,
    resizable: false,
    title: locale.messages.signalDesktopPreferences.message,
    autoHideMenuBar: true,
    backgroundColor: '#3a76f0',
    show: false,
    modal: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      enableRemoteModule: true,
      preload: path.join(__dirname, 'ts', 'windows', 'settings', 'preload.js'),
      nativeWindowOpen: true,
    },
  };

  settingsWindow = new BrowserWindow(options);

  handleCommonWindowEvents(settingsWindow);

  settingsWindow.loadURL(prepareFileUrl([__dirname, 'settings.html']));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  ipc.once('settings-done-rendering', () => {
    if (!settingsWindow) {
      console.warn('settings-done-rendering: no settingsWindow available!');
      return;
    }

    settingsWindow.show();
  });
}

async function getIsLinked() {
  try {
    const number = await sql.sqlCall('getItemById', ['number_id']);
    const password = await sql.sqlCall('getItemById', ['password']);
    return Boolean(number && password);
  } catch (e) {
    return false;
  }
}

let stickerCreatorWindow;
async function showStickerCreator() {
  if (!(await getIsLinked())) {
    const { message } = locale.messages[
      'StickerCreator--Authentication--error'
    ];

    dialog.showMessageBox({
      type: 'warning',
      message,
    });

    return;
  }

  if (stickerCreatorWindow) {
    stickerCreatorWindow.show();
    return;
  }

  const { x = 0, y = 0 } = windowConfig || {};

  const options = {
    x: x + 100,
    y: y + 100,
    width: 800,
    minWidth: 800,
    height: 650,
    title: locale.messages.signalDesktopStickerCreator.message,
    autoHideMenuBar: true,
    backgroundColor: '#3a76f0',
    show: false,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: false,
      enableRemoteModule: true,
      preload: path.join(__dirname, 'sticker-creator/preload.js'),
      nativeWindowOpen: true,
      spellcheck: await getSpellCheckSetting(),
    },
  };

  stickerCreatorWindow = new BrowserWindow(options);
  setupSpellChecker(stickerCreatorWindow, locale.messages);

  handleCommonWindowEvents(stickerCreatorWindow);

  const appUrl = config.enableHttp
    ? prepareUrl(
        new URL('http://localhost:6380/sticker-creator/dist/index.html')
      )
    : prepareFileUrl([__dirname, 'sticker-creator/dist/index.html']);

  stickerCreatorWindow.loadURL(appUrl);

  stickerCreatorWindow.on('closed', () => {
    stickerCreatorWindow = null;
  });

  stickerCreatorWindow.once('ready-to-show', () => {
    stickerCreatorWindow.show();

    if (config.get('openDevTools')) {
      // Open the DevTools.
      stickerCreatorWindow.webContents.openDevTools();
    }
  });
}

let debugLogWindow;
async function showDebugLogWindow() {
  if (debugLogWindow) {
    debugLogWindow.show();
    return;
  }

  const theme = await settingsChannel.getSettingFromMainWindow('themeSetting');
  const size = mainWindow.getSize();
  const options = {
    width: Math.max(size[0] - 100, MIN_WIDTH),
    height: Math.max(size[1] - 100, MIN_HEIGHT),
    resizable: false,
    title: locale.messages.debugLog.message,
    autoHideMenuBar: true,
    backgroundColor: '#3a76f0',
    show: false,
    modal: true,
    webPreferences: {
      ...defaultWebPrefs,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'debug_log_preload.js'),
      nativeWindowOpen: true,
    },
    parent: mainWindow,
  };

  debugLogWindow = new BrowserWindow(options);

  handleCommonWindowEvents(debugLogWindow);

  debugLogWindow.loadURL(
    prepareFileUrl([__dirname, 'debug_log.html'], { theme })
  );

  debugLogWindow.on('closed', () => {
    removeDarkOverlay();
    debugLogWindow = null;
  });

  debugLogWindow.once('ready-to-show', () => {
    addDarkOverlay();
    debugLogWindow.show();
  });
}

let permissionsPopupWindow;
function showPermissionsPopupWindow(forCalling, forCamera) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    if (permissionsPopupWindow) {
      permissionsPopupWindow.show();
      reject(new Error('Permission window already showing'));
    }
    if (!mainWindow) {
      reject(new Error('No main window'));
    }

    const theme = await settingsChannel.getSettingFromMainWindow(
      'themeSetting'
    );
    const size = mainWindow.getSize();
    const options = {
      width: Math.min(400, size[0]),
      height: Math.min(150, size[1]),
      resizable: false,
      title: locale.messages.allowAccess.message,
      autoHideMenuBar: true,
      backgroundColor: '#3a76f0',
      show: false,
      modal: true,
      webPreferences: {
        ...defaultWebPrefs,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enableRemoteModule: true,
        preload: path.join(
          __dirname,
          'ts',
          'windows',
          'permissions',
          'preload.js'
        ),
        nativeWindowOpen: true,
      },
      parent: mainWindow,
    };

    permissionsPopupWindow = new BrowserWindow(options);

    handleCommonWindowEvents(permissionsPopupWindow);

    permissionsPopupWindow.loadURL(
      prepareFileUrl([__dirname, 'permissions_popup.html'], {
        theme,
        forCalling,
        forCamera,
      })
    );

    permissionsPopupWindow.on('closed', () => {
      removeDarkOverlay();
      permissionsPopupWindow = null;

      resolve();
    });

    permissionsPopupWindow.once('ready-to-show', () => {
      addDarkOverlay();
      permissionsPopupWindow.show();
    });
  });
}

async function initializeSQL() {
  const userDataPath = await getRealPath(app.getPath('userData'));

  let key = userConfig.get('key');
  if (!key) {
    console.log(
      'key/initialize: Generating new encryption key, since we did not find it on disk'
    );
    // https://www.zetetic.net/sqlcipher/sqlcipher-api/#key
    key = crypto.randomBytes(32).toString('hex');
    userConfig.set('key', key);
  }

  strictAssert(logger !== undefined, 'Logger must be initialized before sql');

  sqlInitTimeStart = Date.now();
  try {
    await sql.initialize({
      configDir: userDataPath,
      key,
      logger,
    });
  } catch (error) {
    return { ok: false, error };
  } finally {
    sqlInitTimeEnd = Date.now();
  }

  return { ok: true };
}

const onDatabaseError = async error => {
  // Prevent window from re-opening
  ready = false;

  if (mainWindow) {
    mainWindow.webContents.send('callbacks:call:closeDB', []);
    mainWindow.close();
  }
  mainWindow = undefined;

  const buttonIndex = dialog.showMessageBoxSync({
    buttons: [
      locale.messages.copyErrorAndQuit.message,
      locale.messages.deleteAndRestart.message,
    ],
    defaultId: 0,
    detail: redactAll(error),
    message: locale.messages.databaseError.message,
    noLink: true,
    type: 'error',
  });

  if (buttonIndex === 0) {
    clipboard.writeText(`Database startup error:\n\n${redactAll(error)}`);
  } else {
    await sql.removeDB();
    removeUserConfig();
    app.relaunch();
  }

  app.exit(1);
};

const runSQLCorruptionHandler = async () => {
  // This is a glorified event handler. Normally, this promise never resolves,
  // but if there is a corruption error triggered by any query that we run
  // against the database - the promise will resolve and we will call
  // `onDatabaseError`.
  const error = await sql.whenCorrupted();

  const message =
    'Detected sql corruption in main process. ' +
    `Restarting the application immediately. Error: ${error.message}`;
  if (logger) {
    logger.error(message);
  } else {
    console.error(message);
  }

  await onDatabaseError(error.stack);
};

runSQLCorruptionHandler();

let sqlInitPromise;

ipc.on('database-error', (event, error) => {
  onDatabaseError(error);
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
let ready = false;
app.on('ready', async () => {
  logger = await logging.initialize(getMainWindow);

  sqlInitPromise = initializeSQL();

  const startTime = Date.now();

  settingsChannel = new SettingsChannel();
  settingsChannel.install();

  // We use this event only a single time to log the startup time of the app
  // from when it's first ready until the loading screen disappears.
  ipc.once('signal-app-loaded', (event, info) => {
    const { preloadTime, connectTime, processedCount } = info;

    const loadTime = Date.now() - startTime;
    const sqlInitTime = sqlInitTimeEnd - sqlInitTimeStart;

    const messageTime = loadTime - preloadTime - connectTime;
    const messagesPerSec = (processedCount * 1000) / messageTime;

    console.log('App loaded - time:', loadTime);
    console.log('SQL init - time:', sqlInitTime);
    console.log('Preload - time:', preloadTime);
    console.log('WebSocket connect - time:', connectTime);
    console.log('Processed count:', processedCount);
    console.log('Messages per second:', messagesPerSec);

    event.sender.send('ci:event', 'app-loaded', {
      loadTime,
      sqlInitTime,
      preloadTime,
      connectTime,
      processedCount,
      messagesPerSec,
    });
  });

  const userDataPath = await getRealPath(app.getPath('userData'));
  const installPath = await getRealPath(app.getAppPath());

  addSensitivePath(userDataPath);

  if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'test-lib') {
    installFileHandler({
      protocol: electronProtocol,
      userDataPath,
      installPath,
      isWindows: OS.isWindows(),
    });
  }

  installWebHandler({
    enableHttp: config.enableHttp,
    protocol: electronProtocol,
  });

  logger.info('app ready');
  logger.info(`starting version ${packageJson.version}`);

  // This logging helps us debug user reports about broken devices.
  {
    let getMediaAccessStatus;
    // This function is not supported on Linux, so we have a fallback.
    if (systemPreferences.getMediaAccessStatus) {
      getMediaAccessStatus = systemPreferences.getMediaAccessStatus.bind(
        systemPreferences
      );
    } else {
      getMediaAccessStatus = _.noop;
    }
    logger.info(
      'media access status',
      getMediaAccessStatus('microphone'),
      getMediaAccessStatus('camera')
    );
  }

  if (!locale) {
    const appLocale = process.env.NODE_ENV === 'test' ? 'en' : app.getLocale();
    locale = loadLocale({ appLocale, logger });
  }

  GlobalErrors.updateLocale(locale.messages);

  // If the sql initialization takes more than three seconds to complete, we
  // want to notify the user that things are happening
  const timeout = new Promise(resolve => setTimeout(resolve, 3000, 'timeout'));
  // eslint-disable-next-line more/no-then
  Promise.race([sqlInitPromise, timeout]).then(maybeTimeout => {
    if (maybeTimeout !== 'timeout') {
      return;
    }

    console.log(
      'sql.initialize is taking more than three seconds; showing loading dialog'
    );

    loadingWindow = new BrowserWindow({
      show: false,
      width: 300,
      height: 265,
      resizable: false,
      frame: false,
      backgroundColor: '#3a76f0',
      webPreferences: {
        ...defaultWebPrefs,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'ts', 'windows', 'loading', 'preload.js'),
      },
      icon: windowIcon,
    });

    loadingWindow.once('ready-to-show', async () => {
      loadingWindow.show();
      // Wait for sql initialization to complete, but ignore errors
      await sqlInitPromise;
      loadingWindow.destroy();
      loadingWindow = null;
    });

    loadingWindow.loadURL(prepareFileUrl([__dirname, 'loading.html']));
  });

  try {
    await attachments.clearTempPath(userDataPath);
  } catch (err) {
    logger.error(
      'main/ready: Error deleting temp dir:',
      err && err.stack ? err.stack : err
    );
  }

  // Initialize IPC channels before creating the window

  attachmentChannel.initialize({
    configDir: userDataPath,
    cleanupOrphanedAttachments,
  });
  sqlChannels.initialize(sql);
  PowerChannel.initialize({
    send(event) {
      if (!mainWindow) {
        return;
      }
      mainWindow.webContents.send(event);
    },
  });

  // Run window preloading in parallel with database initialization.
  await createWindow();

  const { error: sqlError } = await sqlInitPromise;
  if (sqlError) {
    console.log('sql.initialize was unsuccessful; returning early');

    await onDatabaseError(sqlError.stack);

    return;
  }

  // eslint-disable-next-line more/no-then
  appStartInitialSpellcheckSetting = await getSpellCheckSetting();

  try {
    const IDB_KEY = 'indexeddb-delete-needed';
    const item = await sql.sqlCall('getItemById', [IDB_KEY]);
    if (item && item.value) {
      await sql.sqlCall('removeIndexedDBFiles', []);
      await sql.sqlCall('removeItemById', [IDB_KEY]);
    }
  } catch (err) {
    console.log(
      '(ready event handler) error deleting IndexedDB:',
      err && err.stack ? err.stack : err
    );
  }

  async function cleanupOrphanedAttachments() {
    const allAttachments = await attachments.getAllAttachments(userDataPath);
    const orphanedAttachments = await sql.sqlCall('removeKnownAttachments', [
      allAttachments,
    ]);
    await attachments.deleteAll({
      userDataPath,
      attachments: orphanedAttachments,
    });

    const allStickers = await attachments.getAllStickers(userDataPath);
    const orphanedStickers = await sql.sqlCall('removeKnownStickers', [
      allStickers,
    ]);
    await attachments.deleteAllStickers({
      userDataPath,
      stickers: orphanedStickers,
    });

    const allDraftAttachments = await attachments.getAllDraftAttachments(
      userDataPath
    );
    const orphanedDraftAttachments = await sql.sqlCall(
      'removeKnownDraftAttachments',
      [allDraftAttachments]
    );
    await attachments.deleteAllDraftAttachments({
      userDataPath,
      attachments: orphanedDraftAttachments,
    });
  }

  ready = true;

  setupMenu();

  systemTrayService = new SystemTrayService({ messages: locale.messages });
  systemTrayService.setMainWindow(mainWindow);
  systemTrayService.setEnabled(
    shouldMinimizeToSystemTray(await systemTraySettingCache.get())
  );

  ensureFilePermissions([
    'config.json',
    'sql/db.sqlite',
    'sql/db.sqlite-wal',
    'sql/db.sqlite-shm',
  ]);
});

function setupMenu(options) {
  const { platform } = process;
  const menuOptions = {
    ...options,
    development,
    isProduction: isProduction(app.getVersion()),
    devTools: defaultWebPrefs.devTools,
    showDebugLog: showDebugLogWindow,
    showKeyboardShortcuts,
    showWindow,
    showAbout,
    showSettings: showSettingsWindow,
    showStickerCreator,
    openContactUs,
    openJoinTheBeta,
    openReleaseNotes,
    openSupportPage,
    openForums,
    platform,
    setupAsNewDevice,
    setupAsStandalone,
    forceUpdate,
  };
  const template = createTemplate(menuOptions, locale.messages);
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function requestShutdown() {
  if (!mainWindow || !mainWindow.webContents) {
    return;
  }

  console.log('requestShutdown: Requesting close of mainWindow...');
  const request = new Promise((resolve, reject) => {
    ipc.once('now-ready-for-shutdown', (_event, error) => {
      console.log('requestShutdown: Response received');

      if (error) {
        return reject(error);
      }

      return resolve();
    });
    mainWindow.webContents.send('get-ready-for-shutdown');

    // We'll wait two minutes, then force the app to go down. This can happen if someone
    //   exits the app before we've set everything up in preload() (so the browser isn't
    //   yet listening for these events), or if there are a whole lot of stacked-up tasks.
    // Note: two minutes is also our timeout for SQL tasks in data.js in the browser.
    setTimeout(() => {
      console.log(
        'requestShutdown: Response never received; forcing shutdown.'
      );
      resolve();
    }, 2 * 60 * 1000);
  });

  try {
    await request;
  } catch (error) {
    console.log(
      'requestShutdown error:',
      error && error.stack ? error.stack : error
    );
  }
}

app.on('before-quit', () => {
  console.log('before-quit event', {
    readyForShutdown: mainWindow ? mainWindow.readyForShutdown : null,
    shouldQuit: windowState.shouldQuit(),
  });

  windowState.markShouldQuit();
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  console.log('main process handling window-all-closed');
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  const shouldAutoClose =
    !OS.isMacOS() || isTestEnvironment(config.environment);

  // Only automatically quit if the main window has been created
  // This is necessary because `window-all-closed` can be triggered by the
  // "optimizing application" window closing
  if (shouldAutoClose && mainWindowCreated) {
    app.quit();
  }
});

app.on('activate', () => {
  if (!ready) {
    return;
  }

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

// Defense in depth. We never intend to open webviews or windows. Prevent it completely.
app.on('web-contents-created', (createEvent, contents) => {
  contents.on('will-attach-webview', attachEvent => {
    attachEvent.preventDefault();
  });
  contents.on('new-window', newEvent => {
    newEvent.preventDefault();
  });
});

app.setAsDefaultProtocolClient('sgnl');
app.setAsDefaultProtocolClient('signalcaptcha');
app.on('will-finish-launching', () => {
  // open-url must be set from within will-finish-launching for macOS
  // https://stackoverflow.com/a/43949291
  app.on('open-url', (event, incomingHref) => {
    event.preventDefault();

    if (isCaptchaHref(incomingHref, logger)) {
      const { captcha } = parseCaptchaHref(incomingHref, logger);
      challengeHandler.handleCaptcha(captcha);
      return;
    }

    handleSgnlHref(incomingHref);
  });
});

ipc.on('set-badge-count', (event, count) => {
  app.badgeCount = count;
});

ipc.on('remove-setup-menu-items', () => {
  setupMenu();
});

ipc.on('add-setup-menu-items', () => {
  setupMenu({
    includeSetup: true,
  });
});

ipc.on('draw-attention', () => {
  if (!mainWindow) {
    return;
  }

  if (OS.isWindows() || OS.isLinux()) {
    mainWindow.flashFrame(true);
  }
});

ipc.on('restart', () => {
  console.log('Relaunching application');
  app.relaunch();
  app.quit();
});
ipc.on('shutdown', () => {
  app.quit();
});

ipc.on('set-auto-hide-menu-bar', (event, autoHide) => {
  if (mainWindow) {
    mainWindow.autoHideMenuBar = autoHide;
  }
});

ipc.on('set-menu-bar-visibility', (event, visibility) => {
  if (mainWindow) {
    mainWindow.setMenuBarVisibility(visibility);
  }
});

ipc.on('update-system-tray-setting', (
  _event,
  rawSystemTraySetting /* : Readonly<unknown> */
) => {
  const systemTraySetting = parseSystemTraySetting(rawSystemTraySetting);
  systemTraySettingCache.set(systemTraySetting);

  if (systemTrayService) {
    const isEnabled = shouldMinimizeToSystemTray(systemTraySetting);
    systemTrayService.setEnabled(isEnabled);
  }
});

ipc.on('close-about', () => {
  if (aboutWindow) {
    aboutWindow.close();
  }
});

ipc.on('close-screen-share-controller', () => {
  if (screenShareWindow) {
    screenShareWindow.close();
  }
});

ipc.on('stop-screen-share', () => {
  if (mainWindow) {
    mainWindow.webContents.send('stop-screen-share');
  }
});

ipc.on('show-screen-share', (event, sourceName) => {
  showScreenShareWindow(sourceName);
});

ipc.on('update-tray-icon', (_event, unreadCount) => {
  if (systemTrayService) {
    systemTrayService.setUnreadCount(unreadCount);
  }
});

// Debug Log-related IPC calls

ipc.on('show-debug-log', showDebugLogWindow);
ipc.on('close-debug-log', () => {
  if (debugLogWindow) {
    debugLogWindow.close();
  }
});

// Permissions Popup-related IPC calls

ipc.on('show-permissions-popup', () => {
  showPermissionsPopupWindow(false, false);
});
ipc.handle('show-calling-permissions-popup', async (event, forCamera) => {
  try {
    await showPermissionsPopupWindow(true, forCamera);
  } catch (error) {
    console.error(
      'show-calling-permissions-popup error:',
      error && error.stack ? error.stack : error
    );
  }
});
ipc.on('close-permissions-popup', () => {
  if (permissionsPopupWindow) {
    permissionsPopupWindow.close();
  }
});

// Settings-related IPC calls

function addDarkOverlay() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('add-dark-overlay');
  }
}
function removeDarkOverlay() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('remove-dark-overlay');
  }
}

ipc.on('show-settings', showSettingsWindow);
ipc.on('close-settings', () => {
  if (settingsWindow) {
    settingsWindow.close();
  }
});

ipc.on('delete-all-data', () => {
  if (settingsWindow) {
    settingsWindow.close();
  }
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('delete-all-data');
  }
});

ipc.on('get-built-in-images', async () => {
  try {
    const images = await attachments.getBuiltInImages();
    mainWindow.webContents.send('get-success-built-in-images', null, images);
  } catch (error) {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('get-success-built-in-images', error.message);
    } else {
      console.error('Error handling get-built-in-images:', error.stack);
    }
  }
});

// Ingested in preload.js via a sendSync call
ipc.on('locale-data', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = locale.messages;
});

ipc.on('user-config-key', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = userConfig.get('key');
});

ipc.on('get-user-data-path', event => {
  // eslint-disable-next-line no-param-reassign
  event.returnValue = app.getPath('userData');
});

// Refresh the settings window whenever preferences change
ipc.on('preferences-changed', () => {
  if (settingsWindow && settingsWindow.webContents) {
    settingsWindow.webContents.send('render');
  }
});

function getIncomingHref(argv) {
  return argv.find(arg => isSgnlHref(arg, logger));
}

function getIncomingCaptchaHref(argv) {
  return argv.find(arg => isCaptchaHref(arg, logger));
}

function handleSgnlHref(incomingHref) {
  let command;
  let args;
  let hash;

  if (isSgnlHref(incomingHref)) {
    ({ command, args, hash } = parseSgnlHref(incomingHref, logger));
  } else if (isSignalHttpsLink(incomingHref)) {
    ({ command, args, hash } = parseSignalHttpsLink(incomingHref, logger));
  }

  if (mainWindow && mainWindow.webContents) {
    if (command === 'addstickers') {
      console.log('Opening sticker pack from sgnl protocol link');
      const packId = args.get('pack_id');
      const packKeyHex = args.get('pack_key');
      const packKey = packKeyHex
        ? Buffer.from(packKeyHex, 'hex').toString('base64')
        : '';
      mainWindow.webContents.send('show-sticker-pack', { packId, packKey });
    } else if (command === 'signal.group' && hash) {
      console.log('Showing group from sgnl protocol link');
      mainWindow.webContents.send('show-group-via-link', { hash });
    } else if (command === 'signal.me' && hash) {
      console.log('Showing conversation from sgnl protocol link');
      mainWindow.webContents.send('show-conversation-via-signal.me', { hash });
    } else {
      console.log('Showing warning that we cannot process link');
      mainWindow.webContents.send('unknown-sgnl-link');
    }
  } else {
    console.error('Unhandled sgnl link');
  }
}

ipc.on('install-sticker-pack', (_event, packId, packKeyHex) => {
  const packKey = Buffer.from(packKeyHex, 'hex').toString('base64');
  mainWindow.webContents.send('install-sticker-pack', { packId, packKey });
});

ipc.on('ensure-file-permissions', async event => {
  await ensureFilePermissions();
  event.reply('ensure-file-permissions-done');
});

/**
 * Ensure files in the user's data directory have the proper permissions.
 * Optionally takes an array of file paths to exclusively affect.
 *
 * @param {string[]} [onlyFiles] - Only ensure permissions on these given files
 */
async function ensureFilePermissions(onlyFiles) {
  console.log('Begin ensuring permissions');

  const start = Date.now();
  const userDataPath = await getRealPath(app.getPath('userData'));
  // fast-glob uses `/` for all platforms
  const userDataGlob = normalizePath(path.join(userDataPath, '**', '*'));

  // Determine files to touch
  const files = onlyFiles
    ? onlyFiles.map(f => path.join(userDataPath, f))
    : await fg(userDataGlob, {
        markDirectories: true,
        onlyFiles: false,
        ignore: ['**/Singleton*'],
      });

  console.log(`Ensuring file permissions for ${files.length} files`);

  // Touch each file in a queue
  const q = new PQueue({ concurrency: 5, timeout: 1000 * 60 * 2 });
  q.addAll(
    files.map(f => async () => {
      const isDir = f.endsWith('/');
      try {
        await fs.chmod(path.normalize(f), isDir ? 0o700 : 0o600);
      } catch (error) {
        console.error('ensureFilePermissions: Error from chmod', error.message);
      }
    })
  );

  await q.onEmpty();

  console.log(`Finish ensuring permissions in ${Date.now() - start}ms`);
}
