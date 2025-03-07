// Copyright 2020-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { storiesOf } from '@storybook/react';
import { action } from '@storybook/addon-actions';
import { boolean } from '@storybook/addon-knobs';

import { IMAGE_JPEG } from '../types/MIME';
import { CompositionArea, Props } from './CompositionArea';
import { setupI18n } from '../util/setupI18n';
import enMessages from '../../_locales/en/messages.json';

const i18n = setupI18n('en', enMessages);

const story = storiesOf('Components/CompositionArea', module);

// necessary for the add attachment button to render properly
story.addDecorator(storyFn => <div className="file-input">{storyFn()}</div>);

// necessary for the mic button to render properly
const micCellEl = new DOMParser().parseFromString(
  `
    <div class="capture-audio">
      <button class="microphone"></button>
    </div>
  `,
  'text/html'
).body.firstElementChild as HTMLElement;

const createProps = (overrideProps: Partial<Props> = {}): Props => ({
  i18n,
  micCellEl,
  onChooseAttachment: action('onChooseAttachment'),
  // AttachmentList
  draftAttachments: overrideProps.draftAttachments || [],
  onAddAttachment: action('onAddAttachment'),
  onClearAttachments: action('onClearAttachments'),
  onClickAttachment: action('onClickAttachment'),
  onCloseAttachment: action('onCloseAttachment'),
  // StagedLinkPreview
  linkPreviewLoading: Boolean(overrideProps.linkPreviewLoading),
  linkPreviewResult: overrideProps.linkPreviewResult,
  onCloseLinkPreview: action('onCloseLinkPreview'),
  // Quote
  quotedMessageProps: overrideProps.quotedMessageProps,
  onClickQuotedMessage: action('onClickQuotedMessage'),
  setQuotedMessage: action('setQuotedMessage'),
  // MediaQualitySelector
  onSelectMediaQuality: action('onSelectMediaQuality'),
  shouldSendHighQualityAttachments: Boolean(
    overrideProps.shouldSendHighQualityAttachments
  ),
  // CompositionInput
  onSubmit: action('onSubmit'),
  onEditorStateChange: action('onEditorStateChange'),
  onTextTooLong: action('onTextTooLong'),
  draftText: overrideProps.draftText || undefined,
  clearQuotedMessage: action('clearQuotedMessage'),
  getQuotedMessage: action('getQuotedMessage'),
  sortedGroupMembers: [],
  // EmojiButton
  onPickEmoji: action('onPickEmoji'),
  onSetSkinTone: action('onSetSkinTone'),
  recentEmojis: [],
  skinTone: 1,
  // StickerButton
  knownPacks: overrideProps.knownPacks || [],
  receivedPacks: [],
  installedPacks: [],
  blessedPacks: [],
  recentStickers: [],
  clearInstalledStickerPack: action('clearInstalledStickerPack'),
  onClickAddPack: action('onClickAddPack'),
  onPickSticker: action('onPickSticker'),
  clearShowIntroduction: action('clearShowIntroduction'),
  showPickerHint: false,
  clearShowPickerHint: action('clearShowPickerHint'),
  // Message Requests
  conversationType: 'direct',
  onAccept: action('onAccept'),
  onBlock: action('onBlock'),
  onBlockAndReportSpam: action('onBlockAndReportSpam'),
  onDelete: action('onDelete'),
  onUnblock: action('onUnblock'),
  messageRequestsEnabled: boolean(
    'messageRequestsEnabled',
    overrideProps.messageRequestsEnabled || false
  ),
  title: '',
  // GroupV1 Disabled Actions
  onStartGroupMigration: action('onStartGroupMigration'),
  // GroupV2
  announcementsOnly: boolean(
    'announcementsOnly',
    Boolean(overrideProps.announcementsOnly)
  ),
  areWeAdmin: boolean('areWeAdmin', Boolean(overrideProps.areWeAdmin)),
  groupAdmins: [],
  openConversation: action('openConversation'),
  onCancelJoinRequest: action('onCancelJoinRequest'),
  // SMS-only
  isSMSOnly: overrideProps.isSMSOnly || false,
  isFetchingUUID: overrideProps.isFetchingUUID || false,
});

story.add('Default', () => {
  const props = createProps();

  return <CompositionArea {...props} />;
});

story.add('Starting Text', () => {
  const props = createProps({
    draftText: "here's some starting text",
  });

  return <CompositionArea {...props} />;
});

story.add('Sticker Button', () => {
  const props = createProps({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    knownPacks: [{} as any],
  });

  return <CompositionArea {...props} />;
});

story.add('Message Request', () => {
  const props = createProps({
    messageRequestsEnabled: true,
  });

  return <CompositionArea {...props} />;
});

story.add('SMS-only fetching UUID', () => {
  const props = createProps({
    isSMSOnly: true,
    isFetchingUUID: true,
  });

  return <CompositionArea {...props} />;
});

story.add('SMS-only', () => {
  const props = createProps({
    isSMSOnly: true,
  });

  return <CompositionArea {...props} />;
});

story.add('Attachments', () => {
  const props = createProps({
    draftAttachments: [
      {
        contentType: IMAGE_JPEG,
      },
    ],
  });

  return <CompositionArea {...props} />;
});

story.add('Announcements Only group', () => (
  <CompositionArea
    {...createProps({
      announcementsOnly: true,
      areWeAdmin: false,
    })}
  />
));
