// Copyright 2020-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-param-reassign */
/* eslint-disable more/no-then */
/* eslint-disable no-bitwise */
/* eslint-disable guard-for-in */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-nested-ternary */
/* eslint-disable @typescript-eslint/no-explicit-any */

import fetch, { Response } from 'node-fetch';
import ProxyAgent from 'proxy-agent';
import { Agent } from 'https';
import pProps from 'p-props';
import {
  compact,
  Dictionary,
  escapeRegExp,
  isNumber,
  mapValues,
  zipObject,
} from 'lodash';
import { createVerify } from 'crypto';
import { pki } from 'node-forge';
import is from '@sindresorhus/is';
import PQueue from 'p-queue';
import { v4 as getGuid } from 'uuid';
import { z } from 'zod';
import Long from 'long';

import { assert, strictAssert } from '../util/assert';
import * as durations from '../util/durations';
import { getUserAgent } from '../util/getUserAgent';
import { toWebSafeBase64 } from '../util/webSafeBase64';
import { SocketStatus } from '../types/SocketStatus';
import { isPackIdValid, redactPackId } from '../types/Stickers';
import * as Bytes from '../Bytes';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  bytesFromString,
  concatenateBytes,
  constantTimeEqual,
  decryptAesGcm,
  deriveSecrets,
  encryptCdsDiscoveryRequest,
  getRandomValue,
  splitUuids,
  typedArrayToArrayBuffer,
} from '../Crypto';
import { calculateAgreement, generateKeyPair } from '../Curve';
import * as linkPreviewFetch from '../linkPreviews/linkPreviewFetch';

import {
  StorageServiceCallOptionsType,
  StorageServiceCredentials,
} from '../textsecure.d';
import { SocketManager } from './SocketManager';
import WebSocketResource from './WebsocketResources';
import { SignalService as Proto } from '../protobuf';

import { HTTPError } from './Errors';
import MessageSender from './SendMessage';
import { WebAPICredentials, IRequestHandler } from './Types.d';
import { handleStatusCode, translateError } from './Utils';
import * as log from '../logging/log';

// TODO: remove once we move away from ArrayBuffers
const FIXMEU8 = Uint8Array;

// Note: this will break some code that expects to be able to use err.response when a
//   web request fails, because it will force it to text. But it is very useful for
//   debugging failed requests.
const DEBUG = false;

type SgxConstantsType = {
  SGX_FLAGS_INITTED: Long;
  SGX_FLAGS_DEBUG: Long;
  SGX_FLAGS_MODE64BIT: Long;
  SGX_FLAGS_PROVISION_KEY: Long;
  SGX_FLAGS_EINITTOKEN_KEY: Long;
  SGX_FLAGS_RESERVED: Long;
  SGX_XFRM_LEGACY: Long;
  SGX_XFRM_AVX: Long;
  SGX_XFRM_RESERVED: Long;
};

let sgxConstantCache: SgxConstantsType | null = null;

function makeLong(value: string): Long {
  return Long.fromString(value);
}
function getSgxConstants() {
  if (sgxConstantCache) {
    return sgxConstantCache;
  }

  sgxConstantCache = {
    SGX_FLAGS_INITTED: makeLong('x0000000000000001L'),
    SGX_FLAGS_DEBUG: makeLong('x0000000000000002L'),
    SGX_FLAGS_MODE64BIT: makeLong('x0000000000000004L'),
    SGX_FLAGS_PROVISION_KEY: makeLong('x0000000000000004L'),
    SGX_FLAGS_EINITTOKEN_KEY: makeLong('x0000000000000004L'),
    SGX_FLAGS_RESERVED: makeLong('xFFFFFFFFFFFFFFC8L'),
    SGX_XFRM_LEGACY: makeLong('x0000000000000003L'),
    SGX_XFRM_AVX: makeLong('x0000000000000006L'),
    SGX_XFRM_RESERVED: makeLong('xFFFFFFFFFFFFFFF8L'),
  };

  return sgxConstantCache;
}

function _btoa(str: any) {
  let buffer;

  if (str instanceof Buffer) {
    buffer = str;
  } else {
    buffer = Buffer.from(str.toString(), 'binary');
  }

  return buffer.toString('base64');
}

const _call = (object: any) => Object.prototype.toString.call(object);

const ArrayBufferToString = _call(new ArrayBuffer(0));
const Uint8ArrayToString = _call(new Uint8Array());

function _getString(thing: any): string {
  if (typeof thing !== 'string') {
    if (_call(thing) === Uint8ArrayToString) {
      return String.fromCharCode.apply(null, thing);
    }
    if (_call(thing) === ArrayBufferToString) {
      return _getString(new Uint8Array(thing));
    }
  }

  return thing;
}

// prettier-ignore
function _b64ToUint6(nChr: number) {
  return nChr > 64 && nChr < 91
    ? nChr - 65
    : nChr > 96 && nChr < 123
      ? nChr - 71
      : nChr > 47 && nChr < 58
        ? nChr + 4
        : nChr === 43
          ? 62
          : nChr === 47
            ? 63
            : 0;
}

function _getStringable(thing: any) {
  return (
    typeof thing === 'string' ||
    typeof thing === 'number' ||
    typeof thing === 'boolean' ||
    (thing === Object(thing) &&
      (_call(thing) === ArrayBufferToString ||
        _call(thing) === Uint8ArrayToString))
  );
}

function _ensureStringed(thing: any): any {
  if (_getStringable(thing)) {
    return _getString(thing);
  }
  if (thing instanceof Array) {
    const res = [];
    for (let i = 0; i < thing.length; i += 1) {
      res[i] = _ensureStringed(thing[i]);
    }

    return res;
  }
  if (thing === Object(thing)) {
    const res: any = {};
    for (const key in thing) {
      res[key] = _ensureStringed(thing[key]);
    }

    return res;
  }
  if (thing === null) {
    return null;
  }
  if (thing === undefined) {
    return undefined;
  }
  throw new Error(`unsure of how to jsonify object of type ${typeof thing}`);
}

function _jsonThing(thing: any) {
  return JSON.stringify(_ensureStringed(thing));
}

function _base64ToBytes(sBase64: string, nBlocksSize?: number) {
  const sB64Enc = sBase64.replace(/[^A-Za-z0-9+/]/g, '');
  const nInLen = sB64Enc.length;
  const nOutLen = nBlocksSize
    ? Math.ceil(((nInLen * 3 + 1) >> 2) / nBlocksSize) * nBlocksSize
    : (nInLen * 3 + 1) >> 2;
  const aBBytes = new ArrayBuffer(nOutLen);
  const taBytes = new Uint8Array(aBBytes);

  let nMod3 = 0;
  let nMod4 = 0;
  let nUint24 = 0;
  let nOutIdx = 0;

  for (let nInIdx = 0; nInIdx < nInLen; nInIdx += 1) {
    nMod4 = nInIdx & 3;
    nUint24 |= _b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << (18 - 6 * nMod4);
    if (nMod4 === 3 || nInLen - nInIdx === 1) {
      for (
        nMod3 = 0;
        nMod3 < 3 && nOutIdx < nOutLen;
        nMod3 += 1, nOutIdx += 1
      ) {
        taBytes[nOutIdx] = (nUint24 >>> ((16 >>> nMod3) & 24)) & 255;
      }
      nUint24 = 0;
    }
  }

  return aBBytes;
}

function _createRedactor(
  ...toReplace: ReadonlyArray<string | undefined>
): RedactUrl {
  // NOTE: It would be nice to remove this cast, but TypeScript doesn't support
  //   it. However, there is [an issue][0] that discusses this in more detail.
  // [0]: https://github.com/Microsoft/TypeScript/issues/16069
  const stringsToReplace = toReplace.filter(Boolean) as Array<string>;
  return href =>
    stringsToReplace.reduce((result: string, stringToReplace: string) => {
      const pattern = RegExp(escapeRegExp(stringToReplace), 'g');
      const replacement = `[REDACTED]${stringToReplace.slice(-3)}`;
      return result.replace(pattern, replacement);
    }, href);
}

function _validateResponse(response: any, schema: any) {
  try {
    for (const i in schema) {
      switch (schema[i]) {
        case 'object':
        case 'string':
        case 'number':
          if (typeof response[i] !== schema[i]) {
            return false;
          }
          break;
        default:
      }
    }
  } catch (ex) {
    return false;
  }

  return true;
}

const FIVE_MINUTES = 5 * durations.MINUTE;

type AgentCacheType = {
  [name: string]: {
    timestamp: number;
    agent: ProxyAgent | Agent;
  };
};
const agents: AgentCacheType = {};

function getContentType(response: Response) {
  if (response.headers && response.headers.get) {
    return response.headers.get('content-type');
  }

  return null;
}

type FetchHeaderListType = { [name: string]: string };
export type HeaderListType = { [name: string]: string | ReadonlyArray<string> };
type HTTPCodeType = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

type RedactUrl = (url: string) => string;

type PromiseAjaxOptionsType = {
  socketManager?: SocketManager;
  accessKey?: string;
  basicAuth?: string;
  certificateAuthority?: string;
  contentType?: string;
  data?: ArrayBuffer | Buffer | string;
  headers?: HeaderListType;
  host?: string;
  password?: string;
  path?: string;
  proxyUrl?: string;
  redactUrl?: RedactUrl;
  redirect?: 'error' | 'follow' | 'manual';
  responseType?:
    | 'json'
    | 'jsonwithdetails'
    | 'arraybuffer'
    | 'arraybufferwithdetails';
  serverUrl?: string;
  stack?: string;
  timeout?: number;
  type: HTTPCodeType;
  unauthenticated?: boolean;
  user?: string;
  validateResponse?: any;
  version: string;
};

type JSONWithDetailsType = {
  data: any;
  contentType: string | null;
  response: Response;
};
type ArrayBufferWithDetailsType = {
  data: ArrayBuffer;
  contentType: string | null;
  response: Response;
};

export const multiRecipient200ResponseSchema = z
  .object({
    uuids404: z.array(z.string()).optional(),
    needsSync: z.boolean().optional(),
  })
  .passthrough();
export type MultiRecipient200ResponseType = z.infer<
  typeof multiRecipient200ResponseSchema
>;

export const multiRecipient409ResponseSchema = z.array(
  z
    .object({
      uuid: z.string(),
      devices: z
        .object({
          missingDevices: z.array(z.number()).optional(),
          extraDevices: z.array(z.number()).optional(),
        })
        .passthrough(),
    })
    .passthrough()
);
export type MultiRecipient409ResponseType = z.infer<
  typeof multiRecipient409ResponseSchema
>;

export const multiRecipient410ResponseSchema = z.array(
  z
    .object({
      uuid: z.string(),
      devices: z
        .object({
          staleDevices: z.array(z.number()).optional(),
        })
        .passthrough(),
    })
    .passthrough()
);
export type MultiRecipient410ResponseType = z.infer<
  typeof multiRecipient410ResponseSchema
>;

function isSuccess(status: number): boolean {
  return status >= 0 && status < 400;
}

function getHostname(url: string): string {
  const urlObject = new URL(url);
  return urlObject.hostname;
}

async function _promiseAjax(
  providedUrl: string | null,
  options: PromiseAjaxOptionsType
): Promise<
  | string
  | ArrayBuffer
  | unknown
  | JSONWithDetailsType
  | ArrayBufferWithDetailsType
> {
  const url = providedUrl || `${options.host}/${options.path}`;

  const unauthLabel = options.unauthenticated ? ' (unauth)' : '';
  if (options.redactUrl) {
    log.info(`${options.type} ${options.redactUrl(url)}${unauthLabel}`);
  } else {
    log.info(`${options.type} ${url}${unauthLabel}`);
  }

  const timeout = typeof options.timeout === 'number' ? options.timeout : 10000;

  const { proxyUrl, socketManager } = options;
  const agentType = options.unauthenticated ? 'unauth' : 'auth';
  const cacheKey = `${proxyUrl}-${agentType}`;

  const { timestamp } = agents[cacheKey] || { timestamp: null };
  if (!timestamp || timestamp + FIVE_MINUTES < Date.now()) {
    if (timestamp) {
      log.info(`Cycling agent for type ${cacheKey}`);
    }
    agents[cacheKey] = {
      agent: proxyUrl
        ? new ProxyAgent(proxyUrl)
        : new Agent({ keepAlive: true }),
      timestamp: Date.now(),
    };
  }
  const { agent } = agents[cacheKey];

  const fetchOptions = {
    method: options.type,
    body: options.data,
    headers: {
      'User-Agent': getUserAgent(options.version),
      'X-Signal-Agent': 'OWD',
      ...options.headers,
    } as FetchHeaderListType,
    redirect: options.redirect,
    agent,
    ca: options.certificateAuthority,
    timeout,
  };

  if (fetchOptions.body instanceof ArrayBuffer) {
    // node-fetch doesn't support ArrayBuffer, only node Buffer
    const contentLength = fetchOptions.body.byteLength;
    fetchOptions.body = Buffer.from(fetchOptions.body);

    // node-fetch doesn't set content-length like S3 requires
    fetchOptions.headers['Content-Length'] = contentLength.toString();
  }

  const { accessKey, basicAuth, unauthenticated } = options;
  if (basicAuth) {
    fetchOptions.headers.Authorization = `Basic ${basicAuth}`;
  } else if (unauthenticated) {
    if (!accessKey) {
      throw new Error(
        '_promiseAjax: mode is unauthenticated, but accessKey was not provided'
      );
    }
    // Access key is already a Base64 string
    fetchOptions.headers['Unidentified-Access-Key'] = accessKey;
  } else if (options.user && options.password) {
    const user = _getString(options.user);
    const password = _getString(options.password);
    const auth = _btoa(`${user}:${password}`);
    fetchOptions.headers.Authorization = `Basic ${auth}`;
  }

  if (options.contentType) {
    fetchOptions.headers['Content-Type'] = options.contentType;
  }

  let response: Response;
  let result: string | ArrayBuffer | unknown;
  try {
    response = socketManager
      ? await socketManager.fetch(url, fetchOptions)
      : await fetch(url, fetchOptions);

    if (
      options.serverUrl &&
      getHostname(options.serverUrl) === getHostname(url)
    ) {
      await handleStatusCode(response.status);

      if (!unauthenticated && response.status === 401) {
        log.error('Got 401 from Signal Server. We might be unlinked.');
        window.Whisper.events.trigger('mightBeUnlinked');
      }
    }

    if (DEBUG && !isSuccess(response.status)) {
      result = await response.text();
    } else if (
      (options.responseType === 'json' ||
        options.responseType === 'jsonwithdetails') &&
      /^application\/json(;.*)?$/.test(
        response.headers.get('Content-Type') || ''
      )
    ) {
      result = await response.json();
    } else if (
      options.responseType === 'arraybuffer' ||
      options.responseType === 'arraybufferwithdetails'
    ) {
      result = await response.arrayBuffer();
    } else {
      result = await response.textConverted();
    }
  } catch (e) {
    if (options.redactUrl) {
      log.error(options.type, options.redactUrl(url), 0, 'Error');
    } else {
      log.error(options.type, url, 0, 'Error');
    }
    const stack = `${e.stack}\nInitial stack:\n${options.stack}`;
    throw makeHTTPError('promiseAjax catch', 0, {}, e.toString(), stack);
  }

  if (!isSuccess(response.status)) {
    if (options.redactUrl) {
      log.info(options.type, options.redactUrl(url), response.status, 'Error');
    } else {
      log.error(options.type, url, response.status, 'Error');
    }

    throw makeHTTPError(
      'promiseAjax: error response',
      response.status,
      response.headers.raw(),
      result,
      options.stack
    );
  }

  if (
    options.responseType === 'json' ||
    options.responseType === 'jsonwithdetails'
  ) {
    if (options.validateResponse) {
      if (!_validateResponse(result, options.validateResponse)) {
        if (options.redactUrl) {
          log.info(
            options.type,
            options.redactUrl(url),
            response.status,
            'Error'
          );
        } else {
          log.error(options.type, url, response.status, 'Error');
        }
        throw makeHTTPError(
          'promiseAjax: invalid response',
          response.status,
          response.headers.raw(),
          result,
          options.stack
        );
      }
    }
  }

  if (options.redactUrl) {
    log.info(options.type, options.redactUrl(url), response.status, 'Success');
  } else {
    log.info(options.type, url, response.status, 'Success');
  }

  if (options.responseType === 'arraybufferwithdetails') {
    assert(result instanceof ArrayBuffer, 'Expected ArrayBuffer result');
    const fullResult: ArrayBufferWithDetailsType = {
      data: result,
      contentType: getContentType(response),
      response,
    };

    return fullResult;
  }

  if (options.responseType === 'jsonwithdetails') {
    const fullResult: JSONWithDetailsType = {
      data: result,
      contentType: getContentType(response),
      response,
    };

    return fullResult;
  }

  return result;
}

async function _retryAjax(
  url: string | null,
  options: PromiseAjaxOptionsType,
  providedLimit?: number,
  providedCount?: number
) {
  const count = (providedCount || 0) + 1;
  const limit = providedLimit || 3;

  return _promiseAjax(url, options).catch(async (e: Error) => {
    if (e instanceof HTTPError && e.code === -1 && count < limit) {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(_retryAjax(url, options, limit, count));
        }, 1000);
      });
    }
    throw e;
  });
}

async function _outerAjax(url: string | null, options: PromiseAjaxOptionsType) {
  options.stack = new Error().stack; // just in case, save stack here.

  return _retryAjax(url, options);
}

function makeHTTPError(
  message: string,
  providedCode: number,
  headers: HeaderListType,
  response: any,
  stack?: string
) {
  return new HTTPError(message, {
    code: providedCode,
    headers,
    response,
    stack,
  });
}

const URL_CALLS = {
  accounts: 'v1/accounts',
  attachmentId: 'v2/attachments/form/upload',
  attestation: 'v1/attestation',
  config: 'v1/config',
  deliveryCert: 'v1/certificate/delivery',
  devices: 'v1/devices',
  directoryAuth: 'v1/directory/auth',
  discovery: 'v1/discovery',
  getGroupAvatarUpload: 'v1/groups/avatar/form',
  getGroupCredentials: 'v1/certificate/group',
  getIceServers: 'v1/accounts/turn',
  getStickerPackUpload: 'v1/sticker/pack/form',
  groupLog: 'v1/groups/logs',
  groups: 'v1/groups',
  groupsViaLink: 'v1/groups/join',
  groupToken: 'v1/groups/token',
  keys: 'v2/keys',
  messages: 'v1/messages',
  multiRecipient: 'v1/messages/multi_recipient',
  profile: 'v1/profile',
  registerCapabilities: 'v1/devices/capabilities',
  reportMessage: 'v1/messages/report',
  signed: 'v2/keys/signed',
  storageManifest: 'v1/storage/manifest',
  storageModify: 'v1/storage/',
  storageRead: 'v1/storage/read',
  storageToken: 'v1/storage/auth',
  supportUnauthenticatedDelivery: 'v1/devices/unauthenticated_delivery',
  updateDeviceName: 'v1/accounts/name',
  whoami: 'v1/accounts/whoami',
  challenge: 'v1/challenge',
};

const WEBSOCKET_CALLS = new Set<keyof typeof URL_CALLS>([
  // MessageController
  'messages',
  'multiRecipient',
  'reportMessage',

  // ProfileController
  'profile',

  // AttachmentControllerV2
  'attachmentId',

  // RemoteConfigController
  'config',

  // Certificate
  'deliveryCert',
  'getGroupCredentials',

  // Devices
  'devices',
  'registerCapabilities',
  'supportUnauthenticatedDelivery',

  // Directory
  'directoryAuth',

  // Storage
  'storageToken',
]);

type InitializeOptionsType = {
  url: string;
  storageUrl: string;
  directoryEnclaveId: string;
  directoryTrustAnchor: string;
  directoryUrl: string;
  cdnUrlObject: {
    readonly '0': string;
    readonly [propName: string]: string;
  };
  certificateAuthority: string;
  contentProxyUrl: string;
  proxyUrl: string;
  version: string;
};

type MessageType = unknown;

type AjaxOptionsType = {
  accessKey?: string;
  basicAuth?: string;
  call: keyof typeof URL_CALLS;
  contentType?: string;
  data?: ArrayBuffer | Buffer | Uint8Array | string;
  headers?: HeaderListType;
  host?: string;
  httpType: HTTPCodeType;
  jsonData?: any;
  password?: string;
  redactUrl?: RedactUrl;
  responseType?: 'json' | 'arraybuffer' | 'arraybufferwithdetails';
  schema?: unknown;
  timeout?: number;
  unauthenticated?: boolean;
  urlParameters?: string;
  username?: string;
  validateResponse?: any;
};

export type WebAPIConnectOptionsType = WebAPICredentials & {
  useWebSocket?: boolean;
};

export type WebAPIConnectType = {
  connect: (options: WebAPIConnectOptionsType) => WebAPIType;
};

export type CapabilitiesType = {
  announcementGroup: boolean;
  gv2: boolean;
  'gv1-migration': boolean;
  senderKey: boolean;
  changeNumber: boolean;
};
export type CapabilitiesUploadType = {
  announcementGroup: true;
  'gv2-3': true;
  'gv1-migration': true;
  senderKey: true;
  changeNumber: true;
};

type StickerPackManifestType = ArrayBuffer;

export type GroupCredentialType = {
  credential: string;
  redemptionTime: number;
};
export type GroupCredentialsType = {
  groupPublicParamsHex: string;
  authCredentialPresentationHex: string;
};
export type GroupLogResponseType = {
  currentRevision?: number;
  start?: number;
  end?: number;
  changes: Proto.GroupChanges;
};

export type ProfileRequestDataType = {
  about: string | null;
  aboutEmoji: string | null;
  avatar: boolean;
  commitment: string;
  name: string;
  paymentAddress: string | null;
  version: string;
};

const uploadAvatarHeadersZod = z
  .object({
    acl: z.string(),
    algorithm: z.string(),
    credential: z.string(),
    date: z.string(),
    key: z.string(),
    policy: z.string(),
    signature: z.string(),
  })
  .passthrough();
export type UploadAvatarHeadersType = z.infer<typeof uploadAvatarHeadersZod>;

export type ProfileType = Readonly<{
  identityKey?: string;
  name?: string;
  about?: string;
  aboutEmoji?: string;
  avatar?: string;
  unidentifiedAccess?: string;
  unrestrictedUnidentifiedAccess?: string;
  username?: string;
  uuid?: string;
  credential?: string;
  capabilities?: unknown;
}>;

export type WebAPIType = {
  confirmCode: (
    number: string,
    code: string,
    newPassword: string,
    registrationId: number,
    deviceName?: string | null,
    options?: { accessKey?: ArrayBuffer; uuid?: string }
  ) => Promise<{ uuid?: string; deviceId: number }>;
  createGroup: (
    group: Proto.IGroup,
    options: GroupCredentialsType
  ) => Promise<void>;
  getAttachment: (cdnKey: string, cdnNumber?: number) => Promise<ArrayBuffer>;
  getAvatar: (path: string) => Promise<ArrayBuffer>;
  getDevices: () => Promise<
    Array<{
      id: number;
      name: string;
      lastSeen: number;
      created: number;
    }>
  >;
  getGroup: (options: GroupCredentialsType) => Promise<Proto.Group>;
  getGroupFromLink: (
    inviteLinkPassword: string,
    auth: GroupCredentialsType
  ) => Promise<Proto.GroupJoinInfo>;
  getGroupAvatar: (key: string) => Promise<ArrayBuffer>;
  getGroupCredentials: (
    startDay: number,
    endDay: number
  ) => Promise<Array<GroupCredentialType>>;
  getGroupExternalCredential: (
    options: GroupCredentialsType
  ) => Promise<Proto.GroupExternalCredential>;
  getGroupLog: (
    startVersion: number,
    options: GroupCredentialsType
  ) => Promise<GroupLogResponseType>;
  getIceServers: () => Promise<{
    username: string;
    password: string;
    urls: Array<string>;
  }>;
  getKeysForIdentifier: (
    identifier: string,
    deviceId?: number
  ) => Promise<ServerKeysType>;
  getKeysForIdentifierUnauth: (
    identifier: string,
    deviceId?: number,
    options?: { accessKey?: string }
  ) => Promise<ServerKeysType>;
  getMyKeys: () => Promise<number>;
  getProfile: (
    identifier: string,
    options?: {
      profileKeyVersion?: string;
      profileKeyCredentialRequest?: string;
    }
  ) => Promise<ProfileType>;
  getProfileUnauth: (
    identifier: string,
    options: {
      accessKey: string;
      profileKeyVersion?: string;
      profileKeyCredentialRequest?: string;
    }
  ) => Promise<ProfileType>;
  getProvisioningResource: (
    handler: IRequestHandler
  ) => Promise<WebSocketResource>;
  getSenderCertificate: (
    withUuid?: boolean
  ) => Promise<{ certificate: string }>;
  getSticker: (packId: string, stickerId: number) => Promise<any>;
  getStickerPackManifest: (packId: string) => Promise<StickerPackManifestType>;
  getStorageCredentials: MessageSender['getStorageCredentials'];
  getStorageManifest: MessageSender['getStorageManifest'];
  getStorageRecords: MessageSender['getStorageRecords'];
  getUuidsForE164s: (
    e164s: ReadonlyArray<string>
  ) => Promise<Dictionary<string | null>>;
  fetchLinkPreviewMetadata: (
    href: string,
    abortSignal: AbortSignal
  ) => Promise<null | linkPreviewFetch.LinkPreviewMetadata>;
  fetchLinkPreviewImage: (
    href: string,
    abortSignal: AbortSignal
  ) => Promise<null | linkPreviewFetch.LinkPreviewImage>;
  makeProxiedRequest: (
    targetUrl: string,
    options?: ProxiedRequestOptionsType
  ) => Promise<
    | ArrayBufferWithDetailsType
    | {
        result: ArrayBufferWithDetailsType;
        totalSize: number;
      }
  >;
  makeSfuRequest: (
    targetUrl: string,
    type: HTTPCodeType,
    headers: HeaderListType,
    body: ArrayBuffer | undefined
  ) => Promise<ArrayBufferWithDetailsType>;
  modifyGroup: (
    changes: Proto.GroupChange.IActions,
    options: GroupCredentialsType,
    inviteLinkBase64?: string
  ) => Promise<Proto.IGroupChange>;
  modifyStorageRecords: MessageSender['modifyStorageRecords'];
  putAttachment: (encryptedBin: ArrayBuffer) => Promise<string>;
  putProfile: (
    jsonData: ProfileRequestDataType
  ) => Promise<UploadAvatarHeadersType | undefined>;
  registerCapabilities: (capabilities: CapabilitiesUploadType) => Promise<void>;
  putStickers: (
    encryptedManifest: ArrayBuffer,
    encryptedStickers: Array<ArrayBuffer>,
    onProgress?: () => void
  ) => Promise<string>;
  registerKeys: (genKeys: KeysType) => Promise<void>;
  registerSupportForUnauthenticatedDelivery: () => Promise<void>;
  reportMessage: (senderE164: string, serverGuid: string) => Promise<void>;
  requestVerificationSMS: (number: string) => Promise<void>;
  requestVerificationVoice: (number: string) => Promise<void>;
  sendMessages: (
    destination: string,
    messageArray: Array<MessageType>,
    timestamp: number,
    online?: boolean
  ) => Promise<void>;
  sendMessagesUnauth: (
    destination: string,
    messageArray: Array<MessageType>,
    timestamp: number,
    online?: boolean,
    options?: { accessKey?: string }
  ) => Promise<void>;
  sendWithSenderKey: (
    payload: ArrayBuffer,
    accessKeys: ArrayBuffer,
    timestamp: number,
    online?: boolean
  ) => Promise<MultiRecipient200ResponseType>;
  setSignedPreKey: (signedPreKey: SignedPreKeyType) => Promise<void>;
  updateDeviceName: (deviceName: string) => Promise<void>;
  uploadAvatar: (
    uploadAvatarRequestHeaders: UploadAvatarHeadersType,
    avatarData: ArrayBuffer
  ) => Promise<string>;
  uploadGroupAvatar: (
    avatarData: Uint8Array,
    options: GroupCredentialsType
  ) => Promise<string>;
  whoami: () => Promise<{
    uuid?: string;
    number?: string;
  }>;
  sendChallengeResponse: (challengeResponse: ChallengeType) => Promise<void>;
  getConfig: () => Promise<
    Array<{ name: string; enabled: boolean; value: string | null }>
  >;
  authenticate: (credentials: WebAPICredentials) => Promise<void>;
  logout: () => Promise<void>;
  getSocketStatus: () => SocketStatus;
  registerRequestHandler: (handler: IRequestHandler) => void;
  unregisterRequestHandler: (handler: IRequestHandler) => void;
  checkSockets: () => void;
  onOnline: () => Promise<void>;
  onOffline: () => Promise<void>;
};

export type SignedPreKeyType = {
  keyId: number;
  publicKey: ArrayBuffer;
  signature: ArrayBuffer;
};

export type KeysType = {
  identityKey: ArrayBuffer;
  signedPreKey: SignedPreKeyType;
  preKeys: Array<{
    keyId: number;
    publicKey: ArrayBuffer;
  }>;
};

export type ServerKeysType = {
  devices: Array<{
    deviceId: number;
    registrationId: number;
    signedPreKey: {
      keyId: number;
      publicKey: ArrayBuffer;
      signature: ArrayBuffer;
    };
    preKey?: {
      keyId: number;
      publicKey: ArrayBuffer;
    };
  }>;
  identityKey: ArrayBuffer;
};

export type ChallengeType = {
  readonly type: 'recaptcha';
  readonly token: string;
  readonly captcha: string;
};

export type ProxiedRequestOptionsType = {
  returnArrayBuffer?: boolean;
  start?: number;
  end?: number;
};

// We first set up the data that won't change during this session of the app
export function initialize({
  url,
  storageUrl,
  directoryEnclaveId,
  directoryTrustAnchor,
  directoryUrl,
  cdnUrlObject,
  certificateAuthority,
  contentProxyUrl,
  proxyUrl,
  version,
}: InitializeOptionsType): WebAPIConnectType {
  if (!is.string(url)) {
    throw new Error('WebAPI.initialize: Invalid server url');
  }
  if (!is.string(storageUrl)) {
    throw new Error('WebAPI.initialize: Invalid storageUrl');
  }
  if (!is.string(directoryEnclaveId)) {
    throw new Error('WebAPI.initialize: Invalid directory enclave id');
  }
  if (!is.string(directoryTrustAnchor)) {
    throw new Error('WebAPI.initialize: Invalid directory enclave id');
  }
  if (!is.string(directoryUrl)) {
    throw new Error('WebAPI.initialize: Invalid directory url');
  }
  if (!is.object(cdnUrlObject)) {
    throw new Error('WebAPI.initialize: Invalid cdnUrlObject');
  }
  if (!is.string(cdnUrlObject['0'])) {
    throw new Error('WebAPI.initialize: Missing CDN 0 configuration');
  }
  if (!is.string(cdnUrlObject['2'])) {
    throw new Error('WebAPI.initialize: Missing CDN 2 configuration');
  }
  if (!is.string(certificateAuthority)) {
    throw new Error('WebAPI.initialize: Invalid certificateAuthority');
  }
  if (!is.string(contentProxyUrl)) {
    throw new Error('WebAPI.initialize: Invalid contentProxyUrl');
  }
  if (proxyUrl && !is.string(proxyUrl)) {
    throw new Error('WebAPI.initialize: Invalid proxyUrl');
  }
  if (!is.string(version)) {
    throw new Error('WebAPI.initialize: Invalid version');
  }

  // Thanks to function-hoisting, we can put this return statement before all of the
  //   below function definitions.
  return {
    connect,
  };

  // Then we connect to the server with user-specific information. This is the only API
  //   exposed to the browser context, ensuring that it can't connect to arbitrary
  //   locations.
  function connect({
    username: initialUsername,
    password: initialPassword,
    useWebSocket = true,
  }: WebAPIConnectOptionsType) {
    let username = initialUsername;
    let password = initialPassword;
    const PARSE_RANGE_HEADER = /\/(\d+)$/;
    const PARSE_GROUP_LOG_RANGE_HEADER = /$versions (\d{1,10})-(\d{1,10})\/(d{1,10})/;

    const socketManager = new SocketManager({
      url,
      certificateAuthority,
      version,
      proxyUrl,
    });

    socketManager.on('statusChange', () => {
      window.Whisper.events.trigger('socketStatusChange');
    });

    socketManager.on('authError', () => {
      window.Whisper.events.trigger('unlinkAndDisconnect');
    });

    if (useWebSocket) {
      socketManager.authenticate({ username, password });
    }

    // Thanks, function hoisting!
    return {
      getSocketStatus,
      checkSockets,
      onOnline,
      onOffline,
      registerRequestHandler,
      unregisterRequestHandler,
      authenticate,
      logout,
      confirmCode,
      createGroup,
      fetchLinkPreviewImage,
      fetchLinkPreviewMetadata,
      getAttachment,
      getAvatar,
      getConfig,
      getDevices,
      getGroup,
      getGroupAvatar,
      getGroupCredentials,
      getGroupExternalCredential,
      getGroupFromLink,
      getGroupLog,
      getIceServers,
      getKeysForIdentifier,
      getKeysForIdentifierUnauth,
      getMyKeys,
      getProfile,
      getProfileUnauth,
      getProvisioningResource,
      getSenderCertificate,
      getSticker,
      getStickerPackManifest,
      getStorageCredentials,
      getStorageManifest,
      getStorageRecords,
      getUuidsForE164s,
      makeProxiedRequest,
      makeSfuRequest,
      modifyGroup,
      modifyStorageRecords,
      putAttachment,
      putProfile,
      putStickers,
      registerCapabilities,
      registerKeys,
      registerSupportForUnauthenticatedDelivery,
      reportMessage,
      requestVerificationSMS,
      requestVerificationVoice,
      sendMessages,
      sendMessagesUnauth,
      sendWithSenderKey,
      setSignedPreKey,
      updateDeviceName,
      uploadAvatar,
      uploadGroupAvatar,
      whoami,
      sendChallengeResponse,
    };

    async function _ajax(param: AjaxOptionsType): Promise<any> {
      if (!param.urlParameters) {
        param.urlParameters = '';
      }

      const useWebSocketForEndpoint =
        useWebSocket && WEBSOCKET_CALLS.has(param.call);

      return _outerAjax(null, {
        socketManager: useWebSocketForEndpoint ? socketManager : undefined,
        basicAuth: param.basicAuth,
        certificateAuthority,
        contentType: param.contentType || 'application/json; charset=utf-8',
        data: param.data || (param.jsonData && _jsonThing(param.jsonData)),
        headers: param.headers,
        host: param.host || url,
        password: param.password || password,
        path: URL_CALLS[param.call] + param.urlParameters,
        proxyUrl,
        responseType: param.responseType,
        timeout: param.timeout,
        type: param.httpType,
        user: param.username || username,
        redactUrl: param.redactUrl,
        serverUrl: url,
        validateResponse: param.validateResponse,
        version,
        unauthenticated: param.unauthenticated,
        accessKey: param.accessKey,
      }).catch((e: Error) => {
        if (!(e instanceof HTTPError)) {
          throw e;
        }
        const translatedError = translateError(e);
        if (translatedError) {
          throw translatedError;
        }
      });
    }

    async function whoami() {
      return _ajax({
        call: 'whoami',
        httpType: 'GET',
        responseType: 'json',
      });
    }

    async function sendChallengeResponse(challengeResponse: ChallengeType) {
      return _ajax({
        call: 'challenge',
        httpType: 'PUT',
        jsonData: challengeResponse,
      });
    }

    async function authenticate({
      username: newUsername,
      password: newPassword,
    }: WebAPICredentials) {
      username = newUsername;
      password = newPassword;

      if (useWebSocket) {
        await socketManager.authenticate({ username, password });
      }
    }

    async function logout() {
      username = '';
      password = '';

      if (useWebSocket) {
        await socketManager.logout();
      }
    }

    function getSocketStatus(): SocketStatus {
      return socketManager.getStatus();
    }

    function checkSockets(): void {
      // Intentionally not awaiting
      socketManager.check();
    }

    async function onOnline(): Promise<void> {
      await socketManager.onOnline();
    }

    async function onOffline(): Promise<void> {
      await socketManager.onOffline();
    }

    function registerRequestHandler(handler: IRequestHandler): void {
      socketManager.registerRequestHandler(handler);
    }

    function unregisterRequestHandler(handler: IRequestHandler): void {
      socketManager.unregisterRequestHandler(handler);
    }

    async function getConfig() {
      type ResType = {
        config: Array<{ name: string; enabled: boolean; value: string | null }>;
      };
      const res: ResType = await _ajax({
        call: 'config',
        httpType: 'GET',
        responseType: 'json',
      });

      return res.config.filter(
        ({ name }: { name: string }) =>
          name.startsWith('desktop.') || name.startsWith('global.')
      );
    }

    async function getSenderCertificate(omitE164?: boolean) {
      return _ajax({
        call: 'deliveryCert',
        httpType: 'GET',
        responseType: 'json',
        validateResponse: { certificate: 'string' },
        ...(omitE164 ? { urlParameters: '?includeE164=false' } : {}),
      });
    }

    async function getStorageCredentials(): Promise<StorageServiceCredentials> {
      return _ajax({
        call: 'storageToken',
        httpType: 'GET',
        responseType: 'json',
        schema: { username: 'string', password: 'string' },
      });
    }

    async function getStorageManifest(
      options: StorageServiceCallOptionsType = {}
    ): Promise<ArrayBuffer> {
      const { credentials, greaterThanVersion } = options;

      return _ajax({
        call: 'storageManifest',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        httpType: 'GET',
        responseType: 'arraybuffer',
        urlParameters: greaterThanVersion
          ? `/version/${greaterThanVersion}`
          : '',
        ...credentials,
      });
    }

    async function getStorageRecords(
      data: ArrayBuffer,
      options: StorageServiceCallOptionsType = {}
    ): Promise<ArrayBuffer> {
      const { credentials } = options;

      return _ajax({
        call: 'storageRead',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PUT',
        responseType: 'arraybuffer',
        ...credentials,
      });
    }

    async function modifyStorageRecords(
      data: ArrayBuffer,
      options: StorageServiceCallOptionsType = {}
    ): Promise<ArrayBuffer> {
      const { credentials } = options;

      return _ajax({
        call: 'storageModify',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PUT',
        // If we run into a conflict, the current manifest is returned -
        //   it will will be an ArrayBuffer at the response key on the Error
        responseType: 'arraybuffer',
        ...credentials,
      });
    }

    async function registerSupportForUnauthenticatedDelivery() {
      return _ajax({
        call: 'supportUnauthenticatedDelivery',
        httpType: 'PUT',
        responseType: 'json',
      });
    }

    async function registerCapabilities(capabilities: CapabilitiesUploadType) {
      return _ajax({
        call: 'registerCapabilities',
        httpType: 'PUT',
        jsonData: capabilities,
      });
    }

    function getProfileUrl(
      identifier: string,
      profileKeyVersion?: string,
      profileKeyCredentialRequest?: string
    ) {
      let profileUrl = `/${identifier}`;

      if (profileKeyVersion) {
        profileUrl += `/${profileKeyVersion}`;
      }
      if (profileKeyVersion && profileKeyCredentialRequest) {
        profileUrl += `/${profileKeyCredentialRequest}`;
      }

      return profileUrl;
    }

    async function getProfile(
      identifier: string,
      options: {
        profileKeyVersion?: string;
        profileKeyCredentialRequest?: string;
      } = {}
    ) {
      const { profileKeyVersion, profileKeyCredentialRequest } = options;

      return _ajax({
        call: 'profile',
        httpType: 'GET',
        urlParameters: getProfileUrl(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
        responseType: 'json',
        redactUrl: _createRedactor(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
      });
    }

    async function putProfile(
      jsonData: ProfileRequestDataType
    ): Promise<UploadAvatarHeadersType | undefined> {
      const res = await _ajax({
        call: 'profile',
        httpType: 'PUT',
        jsonData,
      });

      if (!res) {
        return;
      }

      const parsed = JSON.parse(res);
      return uploadAvatarHeadersZod.parse(parsed);
    }

    async function getProfileUnauth(
      identifier: string,
      options: {
        accessKey: string;
        profileKeyVersion?: string;
        profileKeyCredentialRequest?: string;
      }
    ) {
      const {
        accessKey,
        profileKeyVersion,
        profileKeyCredentialRequest,
      } = options;

      return _ajax({
        call: 'profile',
        httpType: 'GET',
        urlParameters: getProfileUrl(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
        responseType: 'json',
        unauthenticated: true,
        accessKey,
        redactUrl: _createRedactor(
          identifier,
          profileKeyVersion,
          profileKeyCredentialRequest
        ),
      });
    }

    async function getAvatar(path: string) {
      // Using _outerAJAX, since it's not hardcoded to the Signal Server. Unlike our
      //   attachment CDN, it uses our self-signed certificate, so we pass it in.
      return (await _outerAjax(`${cdnUrlObject['0']}/${path}`, {
        certificateAuthority,
        contentType: 'application/octet-stream',
        proxyUrl,
        responseType: 'arraybuffer',
        timeout: 0,
        type: 'GET',
        redactUrl: (href: string) => {
          const pattern = RegExp(escapeRegExp(path), 'g');
          return href.replace(pattern, `[REDACTED]${path.slice(-3)}`);
        },
        version,
      })) as ArrayBuffer;
    }

    async function reportMessage(
      senderE164: string,
      serverGuid: string
    ): Promise<void> {
      await _ajax({
        call: 'reportMessage',
        httpType: 'POST',
        urlParameters: `/${senderE164}/${serverGuid}`,
        responseType: 'arraybuffer',
      });
    }

    async function requestVerificationSMS(number: string) {
      return _ajax({
        call: 'accounts',
        httpType: 'GET',
        urlParameters: `/sms/code/${number}`,
      });
    }

    async function requestVerificationVoice(number: string) {
      return _ajax({
        call: 'accounts',
        httpType: 'GET',
        urlParameters: `/voice/code/${number}`,
      });
    }

    async function confirmCode(
      number: string,
      code: string,
      newPassword: string,
      registrationId: number,
      deviceName?: string | null,
      options: { accessKey?: ArrayBuffer; uuid?: string } = {}
    ) {
      const capabilities: CapabilitiesUploadType = {
        announcementGroup: true,
        'gv2-3': true,
        'gv1-migration': true,
        senderKey: true,
        changeNumber: true,
      };

      const { accessKey, uuid } = options;
      const jsonData: any = {
        capabilities,
        fetchesMessages: true,
        name: deviceName || undefined,
        registrationId,
        supportsSms: false,
        unidentifiedAccessKey: accessKey
          ? _btoa(_getString(accessKey))
          : undefined,
        unrestrictedUnidentifiedAccess: false,
      };

      const call = deviceName ? 'devices' : 'accounts';
      const urlPrefix = deviceName ? '/' : '/code/';

      // Reset old websocket credentials and disconnect.
      // AccountManager is our only caller and it will trigger
      // `registration_done` which will update credentials.
      await logout();

      // Update REST credentials, though. We need them for the call below
      username = number;
      password = newPassword;

      const response = await _ajax({
        call,
        httpType: 'PUT',
        responseType: 'json',
        urlParameters: urlPrefix + code,
        jsonData,
      });

      // Set final REST credentials to let `registerKeys` succeed.
      username = `${uuid || response.uuid || number}.${response.deviceId || 1}`;
      password = newPassword;

      return response;
    }

    async function updateDeviceName(deviceName: string) {
      return _ajax({
        call: 'updateDeviceName',
        httpType: 'PUT',
        jsonData: {
          deviceName,
        },
      });
    }

    async function getIceServers() {
      return _ajax({
        call: 'getIceServers',
        httpType: 'GET',
        responseType: 'json',
      });
    }

    async function getDevices() {
      return _ajax({
        call: 'devices',
        httpType: 'GET',
      });
    }

    type JSONSignedPreKeyType = {
      keyId: number;
      publicKey: string;
      signature: string;
    };

    type JSONKeysType = {
      identityKey: string;
      signedPreKey: JSONSignedPreKeyType;
      preKeys: Array<{
        keyId: number;
        publicKey: string;
      }>;
      lastResortKey: {
        keyId: number;
        publicKey: string;
      };
    };

    async function registerKeys(genKeys: KeysType) {
      const preKeys = genKeys.preKeys.map(key => ({
        keyId: key.keyId,
        publicKey: _btoa(_getString(key.publicKey)),
      }));

      const keys: JSONKeysType = {
        identityKey: _btoa(_getString(genKeys.identityKey)),
        signedPreKey: {
          keyId: genKeys.signedPreKey.keyId,
          publicKey: _btoa(_getString(genKeys.signedPreKey.publicKey)),
          signature: _btoa(_getString(genKeys.signedPreKey.signature)),
        },
        preKeys,
        // This is just to make the server happy (v2 clients should choke on publicKey)
        lastResortKey: {
          keyId: 0x7fffffff,
          publicKey: _btoa('42'),
        },
      };

      return _ajax({
        call: 'keys',
        httpType: 'PUT',
        jsonData: keys,
      });
    }

    async function setSignedPreKey(signedPreKey: SignedPreKeyType) {
      return _ajax({
        call: 'signed',
        httpType: 'PUT',
        jsonData: {
          keyId: signedPreKey.keyId,
          publicKey: _btoa(_getString(signedPreKey.publicKey)),
          signature: _btoa(_getString(signedPreKey.signature)),
        },
      });
    }

    type ServerKeyCountType = {
      count: number;
    };

    async function getMyKeys(): Promise<number> {
      const result: ServerKeyCountType = await _ajax({
        call: 'keys',
        httpType: 'GET',
        responseType: 'json',
        validateResponse: { count: 'number' },
      });

      return result.count;
    }

    type ServerKeyResponseType = {
      devices: Array<{
        deviceId: number;
        registrationId: number;
        signedPreKey: {
          keyId: number;
          publicKey: string;
          signature: string;
        };
        preKey?: {
          keyId: number;
          publicKey: string;
        };
      }>;
      identityKey: string;
    };

    function handleKeys(res: ServerKeyResponseType): ServerKeysType {
      if (!Array.isArray(res.devices)) {
        throw new Error('Invalid response');
      }

      const devices = res.devices.map(device => {
        if (
          !_validateResponse(device, { signedPreKey: 'object' }) ||
          !_validateResponse(device.signedPreKey, {
            publicKey: 'string',
            signature: 'string',
          })
        ) {
          throw new Error('Invalid signedPreKey');
        }

        let preKey;
        if (device.preKey) {
          if (
            !_validateResponse(device, { preKey: 'object' }) ||
            !_validateResponse(device.preKey, { publicKey: 'string' })
          ) {
            throw new Error('Invalid preKey');
          }

          preKey = {
            keyId: device.preKey.keyId,
            publicKey: _base64ToBytes(device.preKey.publicKey),
          };
        }

        return {
          deviceId: device.deviceId,
          registrationId: device.registrationId,
          preKey,
          signedPreKey: {
            keyId: device.signedPreKey.keyId,
            publicKey: _base64ToBytes(device.signedPreKey.publicKey),
            signature: _base64ToBytes(device.signedPreKey.signature),
          },
        };
      });

      return {
        devices,
        identityKey: _base64ToBytes(res.identityKey),
      };
    }

    async function getKeysForIdentifier(identifier: string, deviceId?: number) {
      return _ajax({
        call: 'keys',
        httpType: 'GET',
        urlParameters: `/${identifier}/${deviceId || '*'}`,
        responseType: 'json',
        validateResponse: { identityKey: 'string', devices: 'object' },
      }).then(handleKeys);
    }

    async function getKeysForIdentifierUnauth(
      identifier: string,
      deviceId?: number,
      { accessKey }: { accessKey?: string } = {}
    ) {
      return _ajax({
        call: 'keys',
        httpType: 'GET',
        urlParameters: `/${identifier}/${deviceId || '*'}`,
        responseType: 'json',
        validateResponse: { identityKey: 'string', devices: 'object' },
        unauthenticated: true,
        accessKey,
      }).then(handleKeys);
    }

    function validateMessages(messages: Array<unknown>): void {
      for (const message of messages) {
        strictAssert(message !== null, 'Attempting to send `null` message');
      }
    }

    async function sendMessagesUnauth(
      destination: string,
      messageArray: Array<MessageType>,
      timestamp: number,
      online?: boolean,
      { accessKey }: { accessKey?: string } = {}
    ) {
      const jsonData: any = { messages: messageArray, timestamp };

      if (online) {
        jsonData.online = true;
      }

      validateMessages(messageArray);

      return _ajax({
        call: 'messages',
        httpType: 'PUT',
        urlParameters: `/${destination}`,
        jsonData,
        responseType: 'json',
        unauthenticated: true,
        accessKey,
      });
    }

    async function sendMessages(
      destination: string,
      messageArray: Array<MessageType>,
      timestamp: number,
      online?: boolean
    ) {
      const jsonData: any = { messages: messageArray, timestamp };

      if (online) {
        jsonData.online = true;
      }

      validateMessages(messageArray);

      return _ajax({
        call: 'messages',
        httpType: 'PUT',
        urlParameters: `/${destination}`,
        jsonData,
        responseType: 'json',
      });
    }

    async function sendWithSenderKey(
      data: ArrayBuffer,
      accessKeys: ArrayBuffer,
      timestamp: number,
      online?: boolean
    ): Promise<MultiRecipient200ResponseType> {
      return _ajax({
        call: 'multiRecipient',
        httpType: 'PUT',
        contentType: 'application/vnd.signal-messenger.mrm',
        data,
        urlParameters: `?ts=${timestamp}&online=${online ? 'true' : 'false'}`,
        responseType: 'json',
        unauthenticated: true,
        accessKey: arrayBufferToBase64(accessKeys),
      });
    }

    function redactStickerUrl(stickerUrl: string) {
      return stickerUrl.replace(
        /(\/stickers\/)([^/]+)(\/)/,
        (_, begin: string, packId: string, end: string) =>
          `${begin}${redactPackId(packId)}${end}`
      );
    }

    async function getSticker(packId: string, stickerId: number) {
      if (!isPackIdValid(packId)) {
        throw new Error('getSticker: pack ID was invalid');
      }
      return (await _outerAjax(
        `${cdnUrlObject['0']}/stickers/${packId}/full/${stickerId}`,
        {
          certificateAuthority,
          proxyUrl,
          responseType: 'arraybuffer',
          type: 'GET',
          redactUrl: redactStickerUrl,
          version,
        }
      )) as ArrayBuffer;
    }

    async function getStickerPackManifest(packId: string) {
      if (!isPackIdValid(packId)) {
        throw new Error('getStickerPackManifest: pack ID was invalid');
      }
      return (await _outerAjax(
        `${cdnUrlObject['0']}/stickers/${packId}/manifest.proto`,
        {
          certificateAuthority,
          proxyUrl,
          responseType: 'arraybuffer',
          type: 'GET',
          redactUrl: redactStickerUrl,
          version,
        }
      )) as ArrayBuffer;
    }

    type ServerAttachmentType = {
      key: string;
      credential: string;
      acl: string;
      algorithm: string;
      date: string;
      policy: string;
      signature: string;
    };

    function makePutParams(
      {
        key,
        credential,
        acl,
        algorithm,
        date,
        policy,
        signature,
      }: ServerAttachmentType,
      encryptedBin: ArrayBuffer
    ) {
      // Note: when using the boundary string in the POST body, it needs to be prefixed by
      //   an extra --, and the final boundary string at the end gets a -- prefix and a --
      //   suffix.
      const boundaryString = `----------------${getGuid().replace(/-/g, '')}`;
      const CRLF = '\r\n';
      const getSection = (name: string, value: string) =>
        [
          `--${boundaryString}`,
          `Content-Disposition: form-data; name="${name}"${CRLF}`,
          value,
        ].join(CRLF);

      const start = [
        getSection('key', key),
        getSection('x-amz-credential', credential),
        getSection('acl', acl),
        getSection('x-amz-algorithm', algorithm),
        getSection('x-amz-date', date),
        getSection('policy', policy),
        getSection('x-amz-signature', signature),
        getSection('Content-Type', 'application/octet-stream'),
        `--${boundaryString}`,
        'Content-Disposition: form-data; name="file"',
        `Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ].join(CRLF);
      const end = `${CRLF}--${boundaryString}--${CRLF}`;

      const startBuffer = Buffer.from(start, 'utf8');
      const attachmentBuffer = Buffer.from(encryptedBin);
      const endBuffer = Buffer.from(end, 'utf8');

      const contentLength =
        startBuffer.length + attachmentBuffer.length + endBuffer.length;
      const data = Buffer.concat(
        [startBuffer, attachmentBuffer, endBuffer],
        contentLength
      );

      return {
        data,
        contentType: `multipart/form-data; boundary=${boundaryString}`,
        headers: {
          'Content-Length': contentLength.toString(),
        },
      };
    }

    async function putStickers(
      encryptedManifest: ArrayBuffer,
      encryptedStickers: Array<ArrayBuffer>,
      onProgress?: () => void
    ) {
      // Get manifest and sticker upload parameters
      const { packId, manifest, stickers } = await _ajax({
        call: 'getStickerPackUpload',
        responseType: 'json',
        httpType: 'GET',
        urlParameters: `/${encryptedStickers.length}`,
      });

      // Upload manifest
      const manifestParams = makePutParams(manifest, encryptedManifest);
      // This is going to the CDN, not the service, so we use _outerAjax
      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      // Upload stickers
      const queue = new PQueue({ concurrency: 3, timeout: 1000 * 60 * 2 });
      await Promise.all(
        stickers.map(async (sticker: ServerAttachmentType, index: number) => {
          const stickerParams = makePutParams(
            sticker,
            encryptedStickers[index]
          );
          await queue.add(async () =>
            _outerAjax(`${cdnUrlObject['0']}/`, {
              ...stickerParams,
              certificateAuthority,
              proxyUrl,
              timeout: 0,
              type: 'POST',
              version,
            })
          );
          if (onProgress) {
            onProgress();
          }
        })
      );

      // Done!
      return packId;
    }

    async function getAttachment(cdnKey: string, cdnNumber?: number) {
      const cdnUrl = isNumber(cdnNumber)
        ? cdnUrlObject[cdnNumber] || cdnUrlObject['0']
        : cdnUrlObject['0'];
      // This is going to the CDN, not the service, so we use _outerAjax
      return (await _outerAjax(`${cdnUrl}/attachments/${cdnKey}`, {
        certificateAuthority,
        proxyUrl,
        responseType: 'arraybuffer',
        timeout: 0,
        type: 'GET',
        redactUrl: _createRedactor(cdnKey),
        version,
      })) as ArrayBuffer;
    }

    async function putAttachment(encryptedBin: ArrayBuffer) {
      const response = await _ajax({
        call: 'attachmentId',
        httpType: 'GET',
        responseType: 'json',
      });

      const { attachmentIdString } = response;

      const params = makePutParams(response, encryptedBin);

      // This is going to the CDN, not the service, so we use _outerAjax
      await _outerAjax(`${cdnUrlObject['0']}/attachments/`, {
        ...params,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return attachmentIdString;
    }

    function getHeaderPadding() {
      const max = getRandomValue(1, 64);
      let characters = '';

      for (let i = 0; i < max; i += 1) {
        characters += String.fromCharCode(getRandomValue(65, 122));
      }

      return characters;
    }

    async function fetchLinkPreviewMetadata(
      href: string,
      abortSignal: AbortSignal
    ) {
      return linkPreviewFetch.fetchLinkPreviewMetadata(
        fetch,
        href,
        abortSignal
      );
    }

    async function fetchLinkPreviewImage(
      href: string,
      abortSignal: AbortSignal
    ) {
      return linkPreviewFetch.fetchLinkPreviewImage(fetch, href, abortSignal);
    }

    async function makeProxiedRequest(
      targetUrl: string,
      options: ProxiedRequestOptionsType = {}
    ) {
      const { returnArrayBuffer, start, end } = options;
      const headers: HeaderListType = {
        'X-SignalPadding': getHeaderPadding(),
      };

      if (is.number(start) && is.number(end)) {
        headers.Range = `bytes=${start}-${end}`;
      }

      const result = (await _outerAjax(targetUrl, {
        responseType: returnArrayBuffer ? 'arraybufferwithdetails' : undefined,
        proxyUrl: contentProxyUrl,
        type: 'GET',
        redirect: 'follow',
        redactUrl: () => '[REDACTED_URL]',
        headers,
        version,
      })) as ArrayBufferWithDetailsType;

      if (!returnArrayBuffer) {
        return result;
      }

      const { response } = result as ArrayBufferWithDetailsType;
      if (!response.headers || !response.headers.get) {
        throw new Error('makeProxiedRequest: Problem retrieving header value');
      }

      const range = response.headers.get('content-range');
      const match = PARSE_RANGE_HEADER.exec(range || '');

      if (!match || !match[1]) {
        throw new Error(
          `makeProxiedRequest: Unable to parse total size from ${range}`
        );
      }

      const totalSize = parseInt(match[1], 10);

      return {
        totalSize,
        result,
      };
    }

    async function makeSfuRequest(
      targetUrl: string,
      type: HTTPCodeType,
      headers: HeaderListType,
      body: ArrayBuffer | undefined
    ): Promise<ArrayBufferWithDetailsType> {
      return _outerAjax(targetUrl, {
        certificateAuthority,
        data: body,
        headers,
        proxyUrl,
        responseType: 'arraybufferwithdetails',
        timeout: 0,
        type,
        version,
      }) as Promise<ArrayBufferWithDetailsType>;
    }

    // Groups

    function generateGroupAuth(
      groupPublicParamsHex: string,
      authCredentialPresentationHex: string
    ) {
      return _btoa(`${groupPublicParamsHex}:${authCredentialPresentationHex}`);
    }

    type CredentialResponseType = {
      credentials: Array<GroupCredentialType>;
    };

    async function getGroupCredentials(
      startDay: number,
      endDay: number
    ): Promise<Array<GroupCredentialType>> {
      const response: CredentialResponseType = await _ajax({
        call: 'getGroupCredentials',
        urlParameters: `/${startDay}/${endDay}`,
        httpType: 'GET',
        responseType: 'json',
      });

      return response.credentials;
    }

    async function getGroupExternalCredential(
      options: GroupCredentialsType
    ): Promise<Proto.GroupExternalCredential> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response: ArrayBuffer = await _ajax({
        basicAuth,
        call: 'groupToken',
        httpType: 'GET',
        contentType: 'application/x-protobuf',
        responseType: 'arraybuffer',
        host: storageUrl,
      });

      return Proto.GroupExternalCredential.decode(new FIXMEU8(response));
    }

    function verifyAttributes(attributes: Proto.IAvatarUploadAttributes) {
      const {
        key,
        credential,
        acl,
        algorithm,
        date,
        policy,
        signature,
      } = attributes;

      if (
        !key ||
        !credential ||
        !acl ||
        !algorithm ||
        !date ||
        !policy ||
        !signature
      ) {
        throw new Error(
          'verifyAttributes: Missing value from AvatarUploadAttributes'
        );
      }

      return {
        key,
        credential,
        acl,
        algorithm,
        date,
        policy,
        signature,
      };
    }

    async function uploadAvatar(
      uploadAvatarRequestHeaders: UploadAvatarHeadersType,
      avatarData: ArrayBuffer
    ): Promise<string> {
      const verified = verifyAttributes(uploadAvatarRequestHeaders);
      const { key } = verified;

      const manifestParams = makePutParams(verified, avatarData);

      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return key;
    }

    async function uploadGroupAvatar(
      avatarData: Uint8Array,
      options: GroupCredentialsType
    ): Promise<string> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response: ArrayBuffer = await _ajax({
        basicAuth,
        call: 'getGroupAvatarUpload',
        httpType: 'GET',
        responseType: 'arraybuffer',
        host: storageUrl,
      });
      const attributes = Proto.AvatarUploadAttributes.decode(
        new FIXMEU8(response)
      );

      const verified = verifyAttributes(attributes);
      const { key } = verified;

      const manifestParams = makePutParams(
        verified,
        typedArrayToArrayBuffer(avatarData)
      );

      await _outerAjax(`${cdnUrlObject['0']}/`, {
        ...manifestParams,
        certificateAuthority,
        proxyUrl,
        timeout: 0,
        type: 'POST',
        version,
      });

      return key;
    }

    async function getGroupAvatar(key: string): Promise<ArrayBuffer> {
      return _outerAjax(`${cdnUrlObject['0']}/${key}`, {
        certificateAuthority,
        proxyUrl,
        responseType: 'arraybuffer',
        timeout: 0,
        type: 'GET',
        version,
      }) as Promise<ArrayBuffer>;
    }

    async function createGroup(
      group: Proto.IGroup,
      options: GroupCredentialsType
    ): Promise<void> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );
      const data = Proto.Group.encode(group).finish();

      await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PUT',
      });
    }

    async function getGroup(
      options: GroupCredentialsType
    ): Promise<Proto.Group> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const response: ArrayBuffer = await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        httpType: 'GET',
        responseType: 'arraybuffer',
      });

      return Proto.Group.decode(new FIXMEU8(response));
    }

    async function getGroupFromLink(
      inviteLinkPassword: string,
      auth: GroupCredentialsType
    ): Promise<Proto.GroupJoinInfo> {
      const basicAuth = generateGroupAuth(
        auth.groupPublicParamsHex,
        auth.authCredentialPresentationHex
      );
      const safeInviteLinkPassword = toWebSafeBase64(inviteLinkPassword);

      const response: ArrayBuffer = await _ajax({
        basicAuth,
        call: 'groupsViaLink',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        httpType: 'GET',
        responseType: 'arraybuffer',
        urlParameters: `/${safeInviteLinkPassword}`,
        redactUrl: _createRedactor(safeInviteLinkPassword),
      });

      return Proto.GroupJoinInfo.decode(new FIXMEU8(response));
    }

    async function modifyGroup(
      changes: Proto.GroupChange.IActions,
      options: GroupCredentialsType,
      inviteLinkBase64?: string
    ): Promise<Proto.IGroupChange> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );
      const data = Proto.GroupChange.Actions.encode(changes).finish();
      const safeInviteLinkPassword = inviteLinkBase64
        ? toWebSafeBase64(inviteLinkBase64)
        : undefined;

      const response: ArrayBuffer = await _ajax({
        basicAuth,
        call: 'groups',
        contentType: 'application/x-protobuf',
        data,
        host: storageUrl,
        httpType: 'PATCH',
        responseType: 'arraybuffer',
        urlParameters: safeInviteLinkPassword
          ? `?inviteLinkPassword=${safeInviteLinkPassword}`
          : undefined,
        redactUrl: safeInviteLinkPassword
          ? _createRedactor(safeInviteLinkPassword)
          : undefined,
      });

      return Proto.GroupChange.decode(new FIXMEU8(response));
    }

    async function getGroupLog(
      startVersion: number,
      options: GroupCredentialsType
    ): Promise<GroupLogResponseType> {
      const basicAuth = generateGroupAuth(
        options.groupPublicParamsHex,
        options.authCredentialPresentationHex
      );

      const withDetails: ArrayBufferWithDetailsType = await _ajax({
        basicAuth,
        call: 'groupLog',
        contentType: 'application/x-protobuf',
        host: storageUrl,
        httpType: 'GET',
        responseType: 'arraybufferwithdetails',
        urlParameters: `/${startVersion}`,
      });
      const { data, response } = withDetails;
      const changes = Proto.GroupChanges.decode(new FIXMEU8(data));

      if (response && response.status === 206) {
        const range = response.headers.get('Content-Range');
        const match = PARSE_GROUP_LOG_RANGE_HEADER.exec(range || '');

        const start = match ? parseInt(match[0], 10) : undefined;
        const end = match ? parseInt(match[1], 10) : undefined;
        const currentRevision = match ? parseInt(match[2], 10) : undefined;

        if (
          match &&
          is.number(start) &&
          is.number(end) &&
          is.number(currentRevision)
        ) {
          return {
            changes,
            start,
            end,
            currentRevision,
          };
        }
      }

      return {
        changes,
      };
    }

    function getProvisioningResource(
      handler: IRequestHandler
    ): Promise<WebSocketResource> {
      return socketManager.getProvisioningResource(handler);
    }

    async function getDirectoryAuth(): Promise<{
      username: string;
      password: string;
    }> {
      return _ajax({
        call: 'directoryAuth',
        httpType: 'GET',
        responseType: 'json',
      });
    }

    function validateAttestationQuote({
      serverStaticPublic,
      quote: quoteArrayBuffer,
    }: {
      serverStaticPublic: ArrayBuffer;
      quote: ArrayBuffer;
    }) {
      const SGX_CONSTANTS = getSgxConstants();
      const quote = Buffer.from(quoteArrayBuffer);

      const quoteVersion = quote.readInt16LE(0) & 0xffff;
      if (quoteVersion < 0 || quoteVersion > 2) {
        throw new Error(`Unknown version ${quoteVersion}`);
      }

      const miscSelect = quote.slice(64, 64 + 4);
      if (!miscSelect.every(byte => byte === 0)) {
        throw new Error('Quote miscSelect invalid!');
      }

      const reserved1 = quote.slice(68, 68 + 28);
      if (!reserved1.every(byte => byte === 0)) {
        throw new Error('Quote reserved1 invalid!');
      }

      const flags = Long.fromBytesLE(
        Array.from(quote.slice(96, 96 + 8).values())
      );
      if (
        flags.and(SGX_CONSTANTS.SGX_FLAGS_RESERVED).notEquals(0) ||
        flags.and(SGX_CONSTANTS.SGX_FLAGS_INITTED).equals(0) ||
        flags.and(SGX_CONSTANTS.SGX_FLAGS_MODE64BIT).equals(0)
      ) {
        throw new Error(`Quote flags invalid ${flags.toString()}`);
      }

      const xfrm = Long.fromBytesLE(
        Array.from(quote.slice(104, 104 + 8).values())
      );
      if (xfrm.and(SGX_CONSTANTS.SGX_XFRM_RESERVED).notEquals(0)) {
        throw new Error(`Quote xfrm invalid ${xfrm}`);
      }

      const mrenclave = quote.slice(112, 112 + 32);
      const enclaveIdBytes = Bytes.fromHex(directoryEnclaveId);
      if (mrenclave.compare(enclaveIdBytes) !== 0) {
        throw new Error('Quote mrenclave invalid!');
      }

      const reserved2 = quote.slice(144, 144 + 32);
      if (!reserved2.every(byte => byte === 0)) {
        throw new Error('Quote reserved2 invalid!');
      }

      const reportData = quote.slice(368, 368 + 64);
      const serverStaticPublicBytes = new Uint8Array(serverStaticPublic);
      if (
        !reportData.every((byte, index) => {
          if (index >= 32) {
            return byte === 0;
          }
          return byte === serverStaticPublicBytes[index];
        })
      ) {
        throw new Error('Quote report_data invalid!');
      }

      const reserved3 = quote.slice(208, 208 + 96);
      if (!reserved3.every(byte => byte === 0)) {
        throw new Error('Quote reserved3 invalid!');
      }

      const reserved4 = quote.slice(308, 308 + 60);
      if (!reserved4.every(byte => byte === 0)) {
        throw new Error('Quote reserved4 invalid!');
      }

      const signatureLength = quote.readInt32LE(432) >>> 0;
      if (signatureLength !== quote.byteLength - 436) {
        throw new Error(`Bad signatureLength ${signatureLength}`);
      }

      // const signature = quote.slice(436, 436 + signatureLength);
    }

    function validateAttestationSignatureBody(
      signatureBody: {
        timestamp: string;
        version: number;
        isvEnclaveQuoteBody: string;
        isvEnclaveQuoteStatus: string;
      },
      encodedQuote: string
    ) {
      // Parse timestamp as UTC
      const { timestamp } = signatureBody;
      const utcTimestamp = timestamp.endsWith('Z')
        ? timestamp
        : `${timestamp}Z`;
      const signatureTime = new Date(utcTimestamp).getTime();

      const now = Date.now();
      if (signatureBody.version !== 3) {
        throw new Error('Attestation signature invalid version!');
      }
      if (!encodedQuote.startsWith(signatureBody.isvEnclaveQuoteBody)) {
        throw new Error('Attestion signature mismatches quote!');
      }
      if (signatureBody.isvEnclaveQuoteStatus !== 'OK') {
        throw new Error('Attestation signature status not "OK"!');
      }
      if (signatureTime < now - 24 * 60 * 60 * 1000) {
        throw new Error('Attestation signature timestamp older than 24 hours!');
      }
    }

    async function validateAttestationSignature(
      signature: ArrayBuffer,
      signatureBody: string,
      certificates: string
    ) {
      const CERT_PREFIX = '-----BEGIN CERTIFICATE-----';
      const pem = compact(
        certificates.split(CERT_PREFIX).map(match => {
          if (!match) {
            return null;
          }

          return `${CERT_PREFIX}${match}`;
        })
      );
      if (pem.length < 2) {
        throw new Error(
          `validateAttestationSignature: Expect two or more entries; got ${pem.length}`
        );
      }

      const verify = createVerify('RSA-SHA256');
      verify.update(Buffer.from(bytesFromString(signatureBody)));
      const isValid = verify.verify(pem[0], Buffer.from(signature));
      if (!isValid) {
        throw new Error('Validation of signature across signatureBody failed!');
      }

      const caStore = pki.createCaStore([directoryTrustAnchor]);
      const chain = compact(pem.map(cert => pki.certificateFromPem(cert)));
      const isChainValid = pki.verifyCertificateChain(caStore, chain);
      if (!isChainValid) {
        throw new Error('Validation of certificate chain failed!');
      }

      const leafCert = chain[0];
      const fieldCN = leafCert.subject.getField('CN');
      if (
        !fieldCN ||
        fieldCN.value !== 'Intel SGX Attestation Report Signing'
      ) {
        throw new Error('Leaf cert CN field had unexpected value');
      }
      const fieldO = leafCert.subject.getField('O');
      if (!fieldO || fieldO.value !== 'Intel Corporation') {
        throw new Error('Leaf cert O field had unexpected value');
      }
      const fieldL = leafCert.subject.getField('L');
      if (!fieldL || fieldL.value !== 'Santa Clara') {
        throw new Error('Leaf cert L field had unexpected value');
      }
      const fieldST = leafCert.subject.getField('ST');
      if (!fieldST || fieldST.value !== 'CA') {
        throw new Error('Leaf cert ST field had unexpected value');
      }
      const fieldC = leafCert.subject.getField('C');
      if (!fieldC || fieldC.value !== 'US') {
        throw new Error('Leaf cert C field had unexpected value');
      }
    }

    async function putRemoteAttestation(auth: {
      username: string;
      password: string;
    }) {
      const keyPair = generateKeyPair();
      const { privKey, pubKey } = keyPair;
      // Remove first "key type" byte from public key
      const slicedPubKey = pubKey.slice(1);
      const pubKeyBase64 = arrayBufferToBase64(slicedPubKey);
      // Do request
      const data = JSON.stringify({ clientPublic: pubKeyBase64 });
      const result: JSONWithDetailsType = (await _outerAjax(null, {
        certificateAuthority,
        type: 'PUT',
        contentType: 'application/json; charset=utf-8',
        host: directoryUrl,
        path: `${URL_CALLS.attestation}/${directoryEnclaveId}`,
        user: auth.username,
        password: auth.password,
        responseType: 'jsonwithdetails',
        data,
        timeout: 30000,
        version,
      })) as JSONWithDetailsType;

      const { data: responseBody, response } = result;

      const attestationsLength = Object.keys(responseBody.attestations).length;
      if (attestationsLength > 3) {
        throw new Error(
          'Got more than three attestations from the Contact Discovery Service'
        );
      }
      if (attestationsLength < 1) {
        throw new Error(
          'Got no attestations from the Contact Discovery Service'
        );
      }

      const cookie = response.headers.get('set-cookie');

      // Decode response
      return {
        cookie,
        attestations: await pProps(
          responseBody.attestations,
          async attestation => {
            const decoded = { ...attestation };

            [
              'ciphertext',
              'iv',
              'quote',
              'serverEphemeralPublic',
              'serverStaticPublic',
              'signature',
              'tag',
            ].forEach(prop => {
              decoded[prop] = base64ToArrayBuffer(decoded[prop]);
            });

            // Validate response
            validateAttestationQuote(decoded);
            validateAttestationSignatureBody(
              JSON.parse(decoded.signatureBody),
              attestation.quote
            );
            await validateAttestationSignature(
              decoded.signature,
              decoded.signatureBody,
              decoded.certificates
            );

            // Derive key
            const ephemeralToEphemeral = calculateAgreement(
              decoded.serverEphemeralPublic,
              privKey
            );
            const ephemeralToStatic = calculateAgreement(
              decoded.serverStaticPublic,
              privKey
            );
            const masterSecret = concatenateBytes(
              ephemeralToEphemeral,
              ephemeralToStatic
            );
            const publicKeys = concatenateBytes(
              slicedPubKey,
              decoded.serverEphemeralPublic,
              decoded.serverStaticPublic
            );
            const [clientKey, serverKey] = await deriveSecrets(
              masterSecret,
              publicKeys,
              new ArrayBuffer(0)
            );

            // Decrypt ciphertext into requestId
            const requestId = await decryptAesGcm(
              serverKey,
              decoded.iv,
              concatenateBytes(decoded.ciphertext, decoded.tag)
            );

            return { clientKey, serverKey, requestId };
          }
        ),
      };
    }

    async function getUuidsForE164s(
      e164s: ReadonlyArray<string>
    ): Promise<Dictionary<string | null>> {
      const directoryAuth = await getDirectoryAuth();
      const attestationResult = await putRemoteAttestation(directoryAuth);

      // Encrypt data for discovery
      const data = await encryptCdsDiscoveryRequest(
        attestationResult.attestations,
        e164s
      );
      const { cookie } = attestationResult;

      // Send discovery request
      const discoveryResponse: {
        requestId: string;
        iv: string;
        data: string;
        mac: string;
      } = (await _outerAjax(null, {
        certificateAuthority,
        type: 'PUT',
        headers: cookie
          ? {
              cookie,
            }
          : undefined,
        contentType: 'application/json; charset=utf-8',
        host: directoryUrl,
        path: `${URL_CALLS.discovery}/${directoryEnclaveId}`,
        user: directoryAuth.username,
        password: directoryAuth.password,
        responseType: 'json',
        timeout: 30000,
        data: JSON.stringify(data),
        version,
      })) as any;

      // Decode discovery request response
      const decodedDiscoveryResponse: {
        [K in keyof typeof discoveryResponse]: ArrayBuffer;
      } = mapValues(discoveryResponse, value => {
        return base64ToArrayBuffer(value);
      }) as any;

      const returnedAttestation = Object.values(
        attestationResult.attestations
      ).find(at =>
        constantTimeEqual(at.requestId, decodedDiscoveryResponse.requestId)
      );
      if (!returnedAttestation) {
        throw new Error('No known attestations returned from CDS');
      }

      // Decrypt discovery response
      const decryptedDiscoveryData = await decryptAesGcm(
        returnedAttestation.serverKey,
        decodedDiscoveryResponse.iv,
        concatenateBytes(
          decodedDiscoveryResponse.data,
          decodedDiscoveryResponse.mac
        )
      );

      // Process and return result
      const uuids = splitUuids(decryptedDiscoveryData);

      if (uuids.length !== e164s.length) {
        throw new Error(
          'Returned set of UUIDs did not match returned set of e164s!'
        );
      }

      return zipObject(e164s, uuids);
    }
  }
}
