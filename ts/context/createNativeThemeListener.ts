// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-restricted-syntax */

import { NativeThemeState } from '../types/NativeThemeNotifier.d';

export type Callback = (change: NativeThemeState) => void;

export interface MinimalIPC {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendSync(channel: string): any;

  on(
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (event: unknown, ...args: ReadonlyArray<any>) => void
  ): this;
}

type SystemThemeType = 'dark' | 'light';

export type SystemThemeHolder = { systemTheme: SystemThemeType };

type NativeThemeType = {
  getSystemTheme: () => SystemThemeType;
  subscribe: (fn: Callback) => void;
  update: () => SystemThemeType;
};

export function createNativeThemeListener(
  ipc: MinimalIPC,
  holder: SystemThemeHolder
): NativeThemeType {
  const subscribers = new Array<Callback>();

  let theme = ipc.sendSync('native-theme:init');
  let systemTheme: SystemThemeType;

  function update(): SystemThemeType {
    const nextSystemTheme = theme.shouldUseDarkColors ? 'dark' : 'light';
    // eslint-disable-next-line no-param-reassign
    holder.systemTheme = nextSystemTheme;
    return nextSystemTheme;
  }

  function subscribe(fn: Callback): void {
    subscribers.push(fn);
  }

  ipc.on(
    'native-theme:changed',
    (_event: unknown, change: NativeThemeState) => {
      theme = change;
      systemTheme = update();

      for (const fn of subscribers) {
        fn(change);
      }
    }
  );

  systemTheme = update();

  return {
    getSystemTheme: () => systemTheme,
    subscribe,
    update,
  };
}
