// Copyright 2020-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'buffer';
import pProps from 'p-props';
import { chunk } from 'lodash';
import Long from 'long';
import { HKDF } from '@signalapp/signal-client';

import { calculateAgreement, generateKeyPair } from './Curve';
import * as log from './logging/log';

import {
  CipherType,
  encrypt,
  decrypt,
  HashType,
  hash,
  sign,
} from './util/synchronousCrypto';

// Generate a number between zero and 16383
export function generateRegistrationId(): number {
  const id = new Uint16Array(getRandomBytes(2))[0];

  // eslint-disable-next-line no-bitwise
  return id & 0x3fff;
}

export function typedArrayToArrayBuffer(typedArray: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(typedArray.length);
  // Create a new Uint8Array backed by the ArrayBuffer and copy all values from
  // the `typedArray` into it by calling `.set()` method. Note that raw
  // ArrayBuffer doesn't offer this API, because it is supposed to be used with
  // concrete data view (i.e. Uint8Array, Float64Array, and so on.)
  new Uint8Array(ab).set(typedArray, 0);
  return ab;
}

export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  // NOTE: We can't use `Bytes.toBase64` here because this runs in both
  // node and electron contexts.
  return Buffer.from(arrayBuffer).toString('base64');
}

export function arrayBufferToHex(arrayBuffer: ArrayBuffer): string {
  return Buffer.from(arrayBuffer).toString('hex');
}

export function base64ToArrayBuffer(base64string: string): ArrayBuffer {
  return typedArrayToArrayBuffer(Buffer.from(base64string, 'base64'));
}

export function hexToArrayBuffer(hexString: string): ArrayBuffer {
  return typedArrayToArrayBuffer(Buffer.from(hexString, 'hex'));
}

export function fromEncodedBinaryToArrayBuffer(key: string): ArrayBuffer {
  return typedArrayToArrayBuffer(Buffer.from(key, 'binary'));
}

export function arrayBufferToEncodedBinary(arrayBuffer: ArrayBuffer): string {
  return Buffer.from(arrayBuffer).toString('binary');
}

export function bytesFromString(string: string): ArrayBuffer {
  return typedArrayToArrayBuffer(Buffer.from(string));
}
export function stringFromBytes(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString();
}
export function hexFromBytes(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('hex');
}

export function bytesFromHexString(string: string): ArrayBuffer {
  return typedArrayToArrayBuffer(Buffer.from(string, 'hex'));
}

export async function deriveStickerPackKey(
  packKey: ArrayBuffer
): Promise<ArrayBuffer> {
  const salt = getZeroes(32);
  const info = bytesFromString('Sticker Pack');

  const [part1, part2] = await deriveSecrets(packKey, salt, info);

  return concatenateBytes(part1, part2);
}

export function deriveSecrets(
  input: ArrayBuffer,
  salt: ArrayBuffer,
  info: ArrayBuffer
): [ArrayBuffer, ArrayBuffer, ArrayBuffer] {
  const hkdf = HKDF.new(3);
  const output = hkdf.deriveSecrets(
    3 * 32,
    Buffer.from(input),
    Buffer.from(info),
    Buffer.from(salt)
  );
  return [
    typedArrayToArrayBuffer(output.slice(0, 32)),
    typedArrayToArrayBuffer(output.slice(32, 64)),
    typedArrayToArrayBuffer(output.slice(64, 96)),
  ];
}

export async function deriveMasterKeyFromGroupV1(
  groupV1Id: ArrayBuffer
): Promise<ArrayBuffer> {
  const salt = getZeroes(32);
  const info = bytesFromString('GV2 Migration');

  const [part1] = await deriveSecrets(groupV1Id, salt, info);

  return part1;
}

export async function computeHash(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest({ name: 'SHA-512' }, data);
  return arrayBufferToBase64(digest);
}

// High-level Operations

export type EncryptedDeviceName = {
  ephemeralPublic: ArrayBuffer;
  syntheticIv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

export async function encryptDeviceName(
  deviceName: string,
  identityPublic: ArrayBuffer
): Promise<EncryptedDeviceName> {
  const plaintext = bytesFromString(deviceName);
  const ephemeralKeyPair = generateKeyPair();
  const masterSecret = calculateAgreement(
    identityPublic,
    ephemeralKeyPair.privKey
  );

  const key1 = await hmacSha256(masterSecret, bytesFromString('auth'));
  const syntheticIv = getFirstBytes(await hmacSha256(key1, plaintext), 16);

  const key2 = await hmacSha256(masterSecret, bytesFromString('cipher'));
  const cipherKey = await hmacSha256(key2, syntheticIv);

  const counter = getZeroes(16);
  const ciphertext = await encryptAesCtr(cipherKey, plaintext, counter);

  return {
    ephemeralPublic: ephemeralKeyPair.pubKey,
    syntheticIv,
    ciphertext,
  };
}

export async function decryptDeviceName(
  { ephemeralPublic, syntheticIv, ciphertext }: EncryptedDeviceName,
  identityPrivate: ArrayBuffer
): Promise<string> {
  const masterSecret = calculateAgreement(ephemeralPublic, identityPrivate);

  const key2 = await hmacSha256(masterSecret, bytesFromString('cipher'));
  const cipherKey = await hmacSha256(key2, syntheticIv);

  const counter = getZeroes(16);
  const plaintext = await decryptAesCtr(cipherKey, ciphertext, counter);

  const key1 = await hmacSha256(masterSecret, bytesFromString('auth'));
  const ourSyntheticIv = getFirstBytes(await hmacSha256(key1, plaintext), 16);

  if (!constantTimeEqual(ourSyntheticIv, syntheticIv)) {
    throw new Error('decryptDeviceName: synthetic IV did not match');
  }

  return stringFromBytes(plaintext);
}

// Path structure: 'fa/facdf99c22945b1c9393345599a276f4b36ad7ccdc8c2467f5441b742c2d11fa'
export function getAttachmentLabel(path: string): ArrayBuffer {
  const filename = path.slice(3);

  return base64ToArrayBuffer(filename);
}

const PUB_KEY_LENGTH = 32;
export async function encryptAttachment(
  staticPublicKey: ArrayBuffer,
  path: string,
  plaintext: ArrayBuffer
): Promise<ArrayBuffer> {
  const uniqueId = getAttachmentLabel(path);

  return encryptFile(staticPublicKey, uniqueId, plaintext);
}

export async function decryptAttachment(
  staticPrivateKey: ArrayBuffer,
  path: string,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  const uniqueId = getAttachmentLabel(path);

  return decryptFile(staticPrivateKey, uniqueId, data);
}

export async function encryptFile(
  staticPublicKey: ArrayBuffer,
  uniqueId: ArrayBuffer,
  plaintext: ArrayBuffer
): Promise<ArrayBuffer> {
  const ephemeralKeyPair = generateKeyPair();
  const agreement = calculateAgreement(
    staticPublicKey,
    ephemeralKeyPair.privKey
  );
  const key = await hmacSha256(agreement, uniqueId);

  const prefix = ephemeralKeyPair.pubKey.slice(1);

  return concatenateBytes(prefix, await encryptSymmetric(key, plaintext));
}

export async function decryptFile(
  staticPrivateKey: ArrayBuffer,
  uniqueId: ArrayBuffer,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  const ephemeralPublicKey = getFirstBytes(data, PUB_KEY_LENGTH);
  const ciphertext = getBytes(data, PUB_KEY_LENGTH, data.byteLength);
  const agreement = calculateAgreement(ephemeralPublicKey, staticPrivateKey);

  const key = await hmacSha256(agreement, uniqueId);

  return decryptSymmetric(key, ciphertext);
}

export async function deriveStorageManifestKey(
  storageServiceKey: ArrayBuffer,
  version: number
): Promise<ArrayBuffer> {
  return hmacSha256(storageServiceKey, bytesFromString(`Manifest_${version}`));
}

export async function deriveStorageItemKey(
  storageServiceKey: ArrayBuffer,
  itemID: string
): Promise<ArrayBuffer> {
  return hmacSha256(storageServiceKey, bytesFromString(`Item_${itemID}`));
}

export async function deriveAccessKey(
  profileKey: ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = getZeroes(12);
  const plaintext = getZeroes(16);
  const accessKey = await encryptAesGcm(profileKey, iv, plaintext);

  return getFirstBytes(accessKey, 16);
}

export async function getAccessKeyVerifier(
  accessKey: ArrayBuffer
): Promise<ArrayBuffer> {
  const plaintext = getZeroes(32);

  return hmacSha256(accessKey, plaintext);
}

export async function verifyAccessKey(
  accessKey: ArrayBuffer,
  theirVerifier: ArrayBuffer
): Promise<boolean> {
  const ourVerifier = await getAccessKeyVerifier(accessKey);

  if (constantTimeEqual(ourVerifier, theirVerifier)) {
    return true;
  }

  return false;
}

const IV_LENGTH = 16;
const MAC_LENGTH = 16;
const NONCE_LENGTH = 16;

export async function encryptSymmetric(
  key: ArrayBuffer,
  plaintext: ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = getZeroes(IV_LENGTH);
  const nonce = getRandomBytes(NONCE_LENGTH);

  const cipherKey = await hmacSha256(key, nonce);
  const macKey = await hmacSha256(key, cipherKey);

  const ciphertext = await encryptAes256CbcPkcsPadding(
    cipherKey,
    plaintext,
    iv
  );
  const mac = getFirstBytes(await hmacSha256(macKey, ciphertext), MAC_LENGTH);

  return concatenateBytes(nonce, ciphertext, mac);
}

export async function decryptSymmetric(
  key: ArrayBuffer,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = getZeroes(IV_LENGTH);

  const nonce = getFirstBytes(data, NONCE_LENGTH);
  const ciphertext = getBytes(
    data,
    NONCE_LENGTH,
    data.byteLength - NONCE_LENGTH - MAC_LENGTH
  );
  const theirMac = getBytes(data, data.byteLength - MAC_LENGTH, MAC_LENGTH);

  const cipherKey = await hmacSha256(key, nonce);
  const macKey = await hmacSha256(key, cipherKey);

  const ourMac = getFirstBytes(
    await hmacSha256(macKey, ciphertext),
    MAC_LENGTH
  );
  if (!constantTimeEqual(theirMac, ourMac)) {
    throw new Error(
      'decryptSymmetric: Failed to decrypt; MAC verification failed'
    );
  }

  return decryptAes256CbcPkcsPadding(cipherKey, ciphertext, iv);
}

export function constantTimeEqual(
  left: ArrayBuffer,
  right: ArrayBuffer
): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let result = 0;
  const ta1 = new Uint8Array(left);
  const ta2 = new Uint8Array(right);
  const max = left.byteLength;
  for (let i = 0; i < max; i += 1) {
    // eslint-disable-next-line no-bitwise
    result |= ta1[i] ^ ta2[i];
  }

  return result === 0;
}

// Encryption

export async function hmacSha256(
  key: ArrayBuffer,
  plaintext: ArrayBuffer
): Promise<ArrayBuffer> {
  return sign(key, plaintext);
}

// We use part of the constantTimeEqual algorithm from below here, but we allow ourMac
//   to be longer than the passed-in length. This allows easy comparisons against
//   arbitrary MAC lengths.
export async function verifyHmacSha256(
  plaintext: ArrayBuffer,
  key: ArrayBuffer,
  theirMac: ArrayBuffer,
  length: number
): Promise<void> {
  const ourMac = await hmacSha256(key, plaintext);

  if (theirMac.byteLength !== length || ourMac.byteLength < length) {
    throw new Error('Bad MAC length');
  }
  const a = new Uint8Array(theirMac);
  const b = new Uint8Array(ourMac);
  let result = 0;

  for (let i = 0; i < theirMac.byteLength; i += 1) {
    // eslint-disable-next-line no-bitwise
    result |= a[i] ^ b[i];
  }
  if (result !== 0) {
    throw new Error('Bad MAC');
  }
}

export async function encryptAes256CbcPkcsPadding(
  key: ArrayBuffer,
  plaintext: ArrayBuffer,
  iv: ArrayBuffer
): Promise<ArrayBuffer> {
  const algorithm = {
    name: 'AES-CBC',
    iv,
  };
  const extractable = false;

  const cryptoKey = await window.crypto.subtle.importKey(
    'raw',
    key,
    algorithm,
    extractable,
    ['encrypt']
  );

  return window.crypto.subtle.encrypt(algorithm, cryptoKey, plaintext);
}

export async function decryptAes256CbcPkcsPadding(
  key: ArrayBuffer,
  ciphertext: ArrayBuffer,
  iv: ArrayBuffer
): Promise<ArrayBuffer> {
  const algorithm = {
    name: 'AES-CBC',
    iv,
  };
  const extractable = false;

  const cryptoKey = await window.crypto.subtle.importKey(
    'raw',
    key,
    algorithm,
    extractable,
    ['decrypt']
  );

  return window.crypto.subtle.decrypt(algorithm, cryptoKey, ciphertext);
}

export async function encryptAesCtr(
  key: ArrayBuffer,
  plaintext: ArrayBuffer,
  counter: ArrayBuffer
): Promise<ArrayBuffer> {
  return encrypt(key, plaintext, counter, CipherType.AES256CTR);
}

export async function decryptAesCtr(
  key: ArrayBuffer,
  ciphertext: ArrayBuffer,
  counter: ArrayBuffer
): Promise<ArrayBuffer> {
  return decrypt(key, ciphertext, counter, CipherType.AES256CTR);
}

export async function encryptAesGcm(
  key: ArrayBuffer,
  iv: ArrayBuffer,
  plaintext: ArrayBuffer,
  additionalData?: ArrayBuffer
): Promise<ArrayBuffer> {
  const algorithm = {
    name: 'AES-GCM',
    iv,
    ...(additionalData ? { additionalData } : {}),
  };

  const extractable = false;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    algorithm,
    extractable,
    ['encrypt']
  );

  return crypto.subtle.encrypt(algorithm, cryptoKey, plaintext);
}

export async function decryptAesGcm(
  key: ArrayBuffer,
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer,
  additionalData?: ArrayBuffer
): Promise<ArrayBuffer> {
  const algorithm = {
    name: 'AES-GCM',
    iv,
    ...(additionalData ? { additionalData } : {}),
    tagLength: 128,
  };

  const extractable = false;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    algorithm,
    extractable,
    ['decrypt']
  );

  return crypto.subtle.decrypt(algorithm, cryptoKey, ciphertext);
}

// Hashing

export function sha256(data: ArrayBuffer): ArrayBuffer {
  return hash(HashType.size256, data);
}

// Utility

export function getRandomBytes(n: number): ArrayBuffer {
  const bytes = new Uint8Array(n);
  window.crypto.getRandomValues(bytes);

  return typedArrayToArrayBuffer(bytes);
}

export function getRandomValue(low: number, high: number): number {
  const diff = high - low;
  const bytes = new Uint32Array(1);
  window.crypto.getRandomValues(bytes);

  // Because high and low are inclusive
  const mod = diff + 1;

  return (bytes[0] % mod) + low;
}

export function getZeroes(n: number): ArrayBuffer {
  const result = new Uint8Array(n);

  const value = 0;
  const startIndex = 0;
  const endExclusive = n;
  result.fill(value, startIndex, endExclusive);

  return typedArrayToArrayBuffer(result);
}

export function highBitsToInt(byte: number): number {
  // eslint-disable-next-line no-bitwise
  return (byte & 0xff) >> 4;
}

export function intsToByteHighAndLow(
  highValue: number,
  lowValue: number
): number {
  // eslint-disable-next-line no-bitwise
  return ((highValue << 4) | lowValue) & 0xff;
}

export function trimBytes(buffer: ArrayBuffer, length: number): ArrayBuffer {
  return getFirstBytes(buffer, length);
}

export function getViewOfArrayBuffer(
  buffer: ArrayBuffer,
  start: number,
  finish: number
): ArrayBuffer | SharedArrayBuffer {
  const source = new Uint8Array(buffer);
  const result = source.slice(start, finish);

  return window.Signal.Crypto.typedArrayToArrayBuffer(result);
}

export function concatenateBytes(
  ...elements: Array<ArrayBuffer | Uint8Array>
): ArrayBuffer {
  const length = elements.reduce(
    (total, element) => total + element.byteLength,
    0
  );

  const result = new Uint8Array(length);
  let position = 0;

  const max = elements.length;
  for (let i = 0; i < max; i += 1) {
    const element = new Uint8Array(elements[i]);
    result.set(element, position);
    position += element.byteLength;
  }
  if (position !== result.length) {
    throw new Error('problem concatenating!');
  }

  return typedArrayToArrayBuffer(result);
}

export function splitBytes(
  buffer: ArrayBuffer,
  ...lengths: Array<number>
): Array<ArrayBuffer> {
  const total = lengths.reduce((acc, length) => acc + length, 0);

  if (total !== buffer.byteLength) {
    throw new Error(
      `Requested lengths total ${total} does not match source total ${buffer.byteLength}`
    );
  }

  const source = new Uint8Array(buffer);
  const results = [];
  let position = 0;

  const max = lengths.length;
  for (let i = 0; i < max; i += 1) {
    const length = lengths[i];
    const result = new Uint8Array(length);
    const section = source.slice(position, position + length);
    result.set(section);
    position += result.byteLength;

    results.push(typedArrayToArrayBuffer(result));
  }

  return results;
}

export function getFirstBytes(data: ArrayBuffer, n: number): ArrayBuffer {
  const source = new Uint8Array(data);

  return typedArrayToArrayBuffer(source.subarray(0, n));
}

export function getBytes(
  data: ArrayBuffer | Uint8Array,
  start: number,
  n: number
): ArrayBuffer {
  const source = new Uint8Array(data);

  return typedArrayToArrayBuffer(source.subarray(start, start + n));
}

function _getMacAndData(ciphertext: ArrayBuffer) {
  const dataLength = ciphertext.byteLength - MAC_LENGTH;
  const data = getBytes(ciphertext, 0, dataLength);
  const mac = getBytes(ciphertext, dataLength, MAC_LENGTH);

  return { data, mac };
}

export async function encryptCdsDiscoveryRequest(
  attestations: {
    [key: string]: { clientKey: ArrayBuffer; requestId: ArrayBuffer };
  },
  phoneNumbers: ReadonlyArray<string>
): Promise<Record<string, unknown>> {
  const nonce = getRandomBytes(32);
  const numbersArray = Buffer.concat(
    phoneNumbers.map(number => {
      // Long.fromString handles numbers with or without a leading '+'
      return new Uint8Array(Long.fromString(number).toBytesBE());
    })
  );

  // We've written to the array, so offset === byteLength; we need to reset it. Then we'll
  //   have access to everything in the array when we generate an ArrayBuffer from it.
  const queryDataPlaintext = concatenateBytes(
    nonce,
    typedArrayToArrayBuffer(numbersArray)
  );

  const queryDataKey = getRandomBytes(32);
  const commitment = sha256(queryDataPlaintext);
  const iv = getRandomBytes(12);
  const queryDataCiphertext = await encryptAesGcm(
    queryDataKey,
    iv,
    queryDataPlaintext
  );
  const {
    data: queryDataCiphertextData,
    mac: queryDataCiphertextMac,
  } = _getMacAndData(queryDataCiphertext);

  const envelopes = await pProps(
    attestations,
    async ({ clientKey, requestId }) => {
      const envelopeIv = getRandomBytes(12);
      const ciphertext = await encryptAesGcm(
        clientKey,
        envelopeIv,
        queryDataKey,
        requestId
      );
      const { data, mac } = _getMacAndData(ciphertext);

      return {
        requestId: arrayBufferToBase64(requestId),
        data: arrayBufferToBase64(data),
        iv: arrayBufferToBase64(envelopeIv),
        mac: arrayBufferToBase64(mac),
      };
    }
  );

  return {
    addressCount: phoneNumbers.length,
    commitment: arrayBufferToBase64(commitment),
    data: arrayBufferToBase64(queryDataCiphertextData),
    iv: arrayBufferToBase64(iv),
    mac: arrayBufferToBase64(queryDataCiphertextMac),
    envelopes,
  };
}

export function uuidToArrayBuffer(uuid: string): ArrayBuffer {
  if (uuid.length !== 36) {
    log.warn(
      'uuidToArrayBuffer: received a string of invalid length. Returning an empty ArrayBuffer'
    );
    return new ArrayBuffer(0);
  }

  return typedArrayToArrayBuffer(
    Uint8Array.from(
      chunk(uuid.replace(/-/g, ''), 2).map(pair => parseInt(pair.join(''), 16))
    )
  );
}

export function arrayBufferToUuid(
  arrayBuffer: ArrayBuffer
): undefined | string {
  if (arrayBuffer.byteLength !== 16) {
    log.warn(
      'arrayBufferToUuid: received an ArrayBuffer of invalid length. Returning undefined'
    );
    return undefined;
  }

  const uuids = splitUuids(arrayBuffer);
  if (uuids.length === 1) {
    return uuids[0] || undefined;
  }
  return undefined;
}

export function splitUuids(arrayBuffer: ArrayBuffer): Array<string | null> {
  const uuids = [];
  for (let i = 0; i < arrayBuffer.byteLength; i += 16) {
    const bytes = getBytes(arrayBuffer, i, 16);
    const hex = arrayBufferToHex(bytes);
    const chunks = [
      hex.substring(0, 8),
      hex.substring(8, 12),
      hex.substring(12, 16),
      hex.substring(16, 20),
      hex.substring(20),
    ];
    const uuid = chunks.join('-');
    if (uuid !== '00000000-0000-0000-0000-000000000000') {
      uuids.push(uuid);
    } else {
      uuids.push(null);
    }
  }
  return uuids;
}

export function trimForDisplay(arrayBuffer: ArrayBuffer): ArrayBuffer {
  const padded = new Uint8Array(arrayBuffer);

  let paddingEnd = 0;
  for (paddingEnd; paddingEnd < padded.length; paddingEnd += 1) {
    if (padded[paddingEnd] === 0x00) {
      break;
    }
  }
  return typedArrayToArrayBuffer(padded.slice(0, paddingEnd));
}
