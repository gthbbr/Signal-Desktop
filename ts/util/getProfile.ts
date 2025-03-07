// Copyright 2020-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ProfileKeyCredentialRequestContext } from 'zkgroup';
import { SEALED_SENDER } from '../types/SealedSender';
import { Address } from '../types/Address';
import { QualifiedAddress } from '../types/QualifiedAddress';
import { UUID } from '../types/UUID';
import {
  base64ToArrayBuffer,
  stringFromBytes,
  trimForDisplay,
  verifyAccessKey,
} from '../Crypto';
import {
  generateProfileKeyCredentialRequest,
  getClientZkProfileOperations,
  handleProfileKeyCredential,
} from './zkgroup';
import { getSendOptions } from './getSendOptions';
import { isMe } from './whatTypeOfConversation';
import * as log from '../logging/log';

export async function getProfile(
  providedUuid?: string,
  providedE164?: string
): Promise<void> {
  if (!window.textsecure.messaging) {
    throw new Error(
      'Conversation.getProfile: window.textsecure.messaging not available'
    );
  }

  const id = window.ConversationController.ensureContactIds({
    uuid: providedUuid,
    e164: providedE164,
  });
  const c = window.ConversationController.get(id);
  if (!c) {
    log.error('getProfile: failed to find conversation; doing nothing');
    return;
  }

  const clientZkProfileCipher = getClientZkProfileOperations(
    window.getServerPublicParams()
  );

  let profile;

  try {
    await Promise.all([
      c.deriveAccessKeyIfNeeded(),
      c.deriveProfileKeyVersionIfNeeded(),
    ]);

    const profileKey = c.get('profileKey');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const uuid = c.get('uuid')!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const identifier = c.getSendTarget()!;
    const targetUuid = UUID.checkedLookup(identifier);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const profileKeyVersionHex = c.get('profileKeyVersion')!;
    const existingProfileKeyCredential = c.get('profileKeyCredential');

    let profileKeyCredentialRequestHex: undefined | string;
    let profileCredentialRequestContext:
      | undefined
      | ProfileKeyCredentialRequestContext;

    if (
      profileKey &&
      uuid &&
      profileKeyVersionHex &&
      !existingProfileKeyCredential
    ) {
      log.info('Generating request...');
      ({
        requestHex: profileKeyCredentialRequestHex,
        context: profileCredentialRequestContext,
      } = generateProfileKeyCredentialRequest(
        clientZkProfileCipher,
        uuid,
        profileKey
      ));
    }

    const { sendMetadata = {} } = await getSendOptions(c.attributes);
    const getInfo =
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      sendMetadata[c.get('uuid')!] || sendMetadata[c.get('e164')!] || {};

    if (getInfo.accessKey) {
      try {
        profile = await window.textsecure.messaging.getProfile(identifier, {
          accessKey: getInfo.accessKey,
          profileKeyVersion: profileKeyVersionHex,
          profileKeyCredentialRequest: profileKeyCredentialRequestHex,
        });
      } catch (error) {
        if (error.code === 401 || error.code === 403) {
          log.info(
            `Setting sealedSender to DISABLED for conversation ${c.idForLogging()}`
          );
          c.set({ sealedSender: SEALED_SENDER.DISABLED });
          profile = await window.textsecure.messaging.getProfile(identifier, {
            profileKeyVersion: profileKeyVersionHex,
            profileKeyCredentialRequest: profileKeyCredentialRequestHex,
          });
        } else {
          throw error;
        }
      }
    } else {
      profile = await window.textsecure.messaging.getProfile(identifier, {
        profileKeyVersion: profileKeyVersionHex,
        profileKeyCredentialRequest: profileKeyCredentialRequestHex,
      });
    }

    const identityKey = base64ToArrayBuffer(profile.identityKey);
    const changed = await window.textsecure.storage.protocol.saveIdentity(
      new Address(targetUuid, 1),
      identityKey,
      false
    );
    if (changed) {
      // save identity will close all sessions except for .1, so we
      // must close that one manually.
      const ourUuid = window.textsecure.storage.user.getCheckedUuid();
      await window.textsecure.storage.protocol.archiveSession(
        new QualifiedAddress(ourUuid, new Address(targetUuid, 1))
      );
    }

    const accessKey = c.get('accessKey');
    if (profile.unrestrictedUnidentifiedAccess && profile.unidentifiedAccess) {
      log.info(
        `Setting sealedSender to UNRESTRICTED for conversation ${c.idForLogging()}`
      );
      c.set({
        sealedSender: SEALED_SENDER.UNRESTRICTED,
      });
    } else if (accessKey && profile.unidentifiedAccess) {
      const haveCorrectKey = await verifyAccessKey(
        base64ToArrayBuffer(accessKey),
        base64ToArrayBuffer(profile.unidentifiedAccess)
      );

      if (haveCorrectKey) {
        log.info(
          `Setting sealedSender to ENABLED for conversation ${c.idForLogging()}`
        );
        c.set({
          sealedSender: SEALED_SENDER.ENABLED,
        });
      } else {
        log.info(
          `Setting sealedSender to DISABLED for conversation ${c.idForLogging()}`
        );
        c.set({
          sealedSender: SEALED_SENDER.DISABLED,
        });
      }
    } else {
      log.info(
        `Setting sealedSender to DISABLED for conversation ${c.idForLogging()}`
      );
      c.set({
        sealedSender: SEALED_SENDER.DISABLED,
      });
    }

    if (profile.about) {
      const key = c.get('profileKey');
      if (key) {
        const keyBuffer = base64ToArrayBuffer(key);
        const decrypted = await window.textsecure.crypto.decryptProfile(
          base64ToArrayBuffer(profile.about),
          keyBuffer
        );
        c.set('about', stringFromBytes(trimForDisplay(decrypted)));
      }
    } else {
      c.unset('about');
    }

    if (profile.aboutEmoji) {
      const key = c.get('profileKey');
      if (key) {
        const keyBuffer = base64ToArrayBuffer(key);
        const decrypted = await window.textsecure.crypto.decryptProfile(
          base64ToArrayBuffer(profile.aboutEmoji),
          keyBuffer
        );
        c.set('aboutEmoji', stringFromBytes(trimForDisplay(decrypted)));
      }
    } else {
      c.unset('aboutEmoji');
    }

    if (profile.paymentAddress && isMe(c.attributes)) {
      window.storage.put('paymentAddress', profile.paymentAddress);
    }

    if (profile.capabilities) {
      c.set({ capabilities: profile.capabilities });
    } else {
      c.unset('capabilities');
    }

    if (profileCredentialRequestContext) {
      if (profile.credential) {
        const profileKeyCredential = handleProfileKeyCredential(
          clientZkProfileCipher,
          profileCredentialRequestContext,
          profile.credential
        );
        c.set({ profileKeyCredential });
      } else {
        c.unset('profileKeyCredential');
      }
    }
  } catch (error) {
    switch (error?.code) {
      case 403:
        throw error;
      case 404:
        log.warn(
          `getProfile failure: failed to find a profile for ${c.idForLogging()}`,
          error && error.stack ? error.stack : error
        );
        c.setUnregistered();
        return;
      default:
        log.warn(
          'getProfile failure:',
          c.idForLogging(),
          error && error.stack ? error.stack : error
        );
        return;
    }
  }

  try {
    await c.setEncryptedProfileName(profile.name);
  } catch (error) {
    log.warn(
      'getProfile decryption failure:',
      c.idForLogging(),
      error && error.stack ? error.stack : error
    );
    await c.set({
      profileName: undefined,
      profileFamilyName: undefined,
    });
  }

  try {
    await c.setProfileAvatar(profile.avatar);
  } catch (error) {
    if (error.code === 403 || error.code === 404) {
      log.info(`Clearing profile avatar for conversation ${c.idForLogging()}`);
      c.set({
        profileAvatar: null,
      });
    }
  }

  c.set('profileLastFetchedAt', Date.now());

  window.Signal.Data.updateConversation(c.attributes);
}
