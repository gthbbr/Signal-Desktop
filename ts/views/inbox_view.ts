// Copyright 2014-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as log from '../logging/log';
import { ConversationModel } from '../models/conversations';

window.Whisper = window.Whisper || {};
const { Whisper } = window;

const StickerPackInstallFailedToast = Whisper.ToastView.extend({
  render_attributes() {
    return { toastMessage: window.i18n('stickers--toast--InstallFailed') };
  },
});

const ConversationStack = Whisper.View.extend({
  className: 'conversation-stack',
  lastConversation: null,
  open(conversation: ConversationModel, messageId: string) {
    const id = `conversation-${conversation.cid}`;
    if (id !== this.el.lastChild.id) {
      const view = new Whisper.ConversationView({
        model: conversation,
      });
      this.listenTo(conversation, 'unload', () => this.onUnload(conversation));
      this.listenTo(conversation, 'showSafetyNumber', () =>
        view.showSafetyNumber()
      );
      view.$el.appendTo(this.el);

      if (this.lastConversation && this.lastConversation !== conversation) {
        this.lastConversation.trigger('unload', 'opened another conversation');
        this.stopListening(this.lastConversation);
        this.lastConversation = null;
      }

      this.lastConversation = conversation;
      conversation.trigger('opened', messageId);
    } else if (messageId) {
      conversation.trigger('scroll-to-message', messageId);
    }

    // Make sure poppers are positioned properly
    window.dispatchEvent(new Event('resize'));
  },
  unload() {
    const { lastConversation } = this;
    if (!lastConversation) {
      return;
    }

    lastConversation.trigger('unload', 'force unload requested');
  },
  onUnload(conversation: ConversationModel) {
    if (this.lastConversation === conversation) {
      this.stopListening(this.lastConversation);
      this.lastConversation = null;
    }
  },
});

const AppLoadingScreen = Whisper.View.extend({
  template: () => $('#app-loading-screen').html(),
  className: 'app-loading-screen',
  updateProgress(count: number) {
    if (count > 0) {
      const message = window.i18n('loadingMessages', [count.toString()]);
      this.$('.message').text(message);
    }
  },
  render_attributes: {
    message: window.i18n('loading'),
  },
});

Whisper.InboxView = Whisper.View.extend({
  template: () => $('#two-column').html(),
  className: 'inbox index',
  initialize(
    options: {
      initialLoadComplete?: boolean;
      window?: typeof window;
    } = {}
  ) {
    this.ready = false;
    this.render();

    this.conversation_stack = new ConversationStack({
      el: this.$('.conversation-stack'),
      model: { window: options.window },
    });

    this.renderWhatsNew();

    Whisper.events.on('refreshConversation', ({ oldId, newId }) => {
      const convo = this.conversation_stack.lastConversation;
      if (convo && convo.get('id') === oldId) {
        this.conversation_stack.open(newId);
      }
    });

    // Close current opened conversation to reload the group information once
    // linked.
    Whisper.events.on('setupAsNewDevice', () => {
      this.conversation_stack.unload();
    });

    window.Whisper.events.on('showConversation', async (id, messageId) => {
      const conversation = await window.ConversationController.getOrCreateAndWait(
        id,
        'private'
      );

      conversation.setMarkedUnread(false);

      const { openConversationExternal } = window.reduxActions.conversations;
      if (openConversationExternal) {
        openConversationExternal(conversation.id, messageId);
      }

      this.conversation_stack.open(conversation, messageId);
      this.focusConversation();
    });

    window.Whisper.events.on('showSafetyNumberInConversation', id => {
      const conversation = window.ConversationController.get(id);
      if (conversation) {
        conversation.trigger('showSafetyNumber');
      }
    });

    window.Whisper.events.on('loadingProgress', count => {
      const view = this.appLoadingScreen;
      if (view) {
        view.updateProgress(count);
      }
    });

    if (!options.initialLoadComplete) {
      this.appLoadingScreen = new AppLoadingScreen();
      this.appLoadingScreen.render();
      this.appLoadingScreen.$el.prependTo(this.el);
      this.startConnectionListener();
    } else {
      this.setupLeftPane();
    }

    Whisper.events.on('pack-install-failed', () => {
      const toast = new StickerPackInstallFailedToast();
      toast.$el.appendTo(this.$el);
      toast.render();
    });
  },
  render_attributes: {
    welcomeToSignal: window.i18n('welcomeToSignal'),
    // TODO DESKTOP-1451: add back the selectAContact message
    selectAContact: '',
  },
  events: {
    click: 'onClick',
  },
  renderWhatsNew() {
    if (this.whatsNewView) {
      return;
    }
    this.whatsNewView = new Whisper.ReactWrapperView({
      Component: window.Signal.Components.WhatsNew,
      props: {
        i18n: window.i18n,
      },
    });
    this.$('.whats-new-placeholder').append(this.whatsNewView.el);
  },
  setupLeftPane() {
    if (this.leftPaneView) {
      return;
    }
    this.leftPaneView = new Whisper.ReactWrapperView({
      className: 'left-pane-wrapper',
      JSX: window.Signal.State.Roots.createLeftPane(window.reduxStore),
    });

    this.$('.left-pane-placeholder').append(this.leftPaneView.el);
  },
  startConnectionListener() {
    this.interval = setInterval(() => {
      const status = window.getSocketStatus();
      switch (status) {
        case 'CONNECTING':
          break;
        case 'OPEN':
          clearInterval(this.interval);
          // if we've connected, we can wait for real empty event
          this.interval = null;
          break;
        case 'CLOSING':
        case 'CLOSED':
          clearInterval(this.interval);
          this.interval = null;
          // if we failed to connect, we pretend we got an empty event
          this.onEmpty();
          break;
        default:
          log.warn(
            `startConnectionListener: Found unexpected socket status ${status}; calling onEmpty() manually.`
          );
          this.onEmpty();
          break;
      }
    }, 1000);
  },
  onEmpty() {
    this.setupLeftPane();

    const view = this.appLoadingScreen;
    if (view) {
      this.appLoadingScreen = null;
      view.remove();

      const searchInput = document.querySelector(
        '.module-main-header__search__input'
      ) as HTMLElement;
      searchInput?.focus?.();
    }
  },
  focusConversation(e: MouseEvent) {
    if (e && this.$(e.target).closest('.placeholder').length) {
      return;
    }

    this.$('#header, .gutter').addClass('inactive');
    this.$('.conversation-stack').removeClass('inactive');
  },
  closeRecording(e: MouseEvent) {
    if (e && this.$(e.target).closest('.capture-audio').length > 0) {
      return;
    }
    this.$('.conversation:first .recorder').trigger('close');
  },
  onClick(e: MouseEvent) {
    this.closeRecording(e);
  },
});
