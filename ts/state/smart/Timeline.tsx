// Copyright 2019-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isEmpty, mapValues, pick } from 'lodash';
import React, { RefObject } from 'react';
import { connect } from 'react-redux';
import memoizee from 'memoizee';

import { mapDispatchToProps } from '../actions';
import {
  PropsActionsType as TimelineActionsType,
  ContactSpoofingReviewPropType,
  Timeline,
  WarningType as TimelineWarningType,
} from '../../components/conversation/Timeline';
import { StateType } from '../reducer';
import { ConversationType } from '../ducks/conversations';

import { getIntl } from '../selectors/user';
import {
  getConversationByIdSelector,
  getConversationMessagesSelector,
  getConversationSelector,
  getConversationsByTitleSelector,
  getInvitedContactsForNewlyCreatedGroup,
  getSelectedMessage,
} from '../selectors/conversations';

import { SmartTimelineItem } from './TimelineItem';
import { SmartTypingBubble } from './TypingBubble';
import { SmartLastSeenIndicator } from './LastSeenIndicator';
import { SmartHeroRow } from './HeroRow';
import { SmartTimelineLoadingRow } from './TimelineLoadingRow';
import { renderAudioAttachment } from './renderAudioAttachment';
import { renderEmojiPicker } from './renderEmojiPicker';
import { renderReactionPicker } from './renderReactionPicker';

import { getOwn } from '../../util/getOwn';
import { assert } from '../../util/assert';
import { missingCaseError } from '../../util/missingCaseError';
import { getGroupMemberships } from '../../util/getGroupMemberships';
import {
  dehydrateCollisionsWithConversations,
  getCollisionsFromMemberships,
  invertIdsByTitle,
} from '../../util/groupMemberNameCollisions';
import { ContactSpoofingType } from '../../util/contactSpoofing';

type ExternalProps = {
  id: string;

  // Note: most action creators are not wired into redux; for now they
  //   are provided by ConversationView in setupTimeline().
};

const createBoundOnHeightChange = memoizee(
  (
    onHeightChange: (messageId: string) => unknown,
    messageId: string
  ): (() => unknown) => {
    return () => onHeightChange(messageId);
  },
  { max: 500 }
);

function renderItem({
  actionProps,
  containerElementRef,
  conversationId,
  messageId,
  nextMessageId,
  onHeightChange,
  previousMessageId,
}: {
  actionProps: TimelineActionsType;
  containerElementRef: RefObject<HTMLElement>;
  conversationId: string;
  messageId: string;
  nextMessageId: undefined | string;
  onHeightChange: (messageId: string) => unknown;
  previousMessageId: undefined | string;
}): JSX.Element {
  return (
    <SmartTimelineItem
      {...actionProps}
      containerElementRef={containerElementRef}
      conversationId={conversationId}
      messageId={messageId}
      previousMessageId={previousMessageId}
      nextMessageId={nextMessageId}
      onHeightChange={createBoundOnHeightChange(onHeightChange, messageId)}
      renderEmojiPicker={renderEmojiPicker}
      renderReactionPicker={renderReactionPicker}
      renderAudioAttachment={renderAudioAttachment}
    />
  );
}

function renderLastSeenIndicator(id: string): JSX.Element {
  return <SmartLastSeenIndicator id={id} />;
}

function renderHeroRow(
  id: string,
  onHeightChange: () => unknown,
  unblurAvatar: () => void,
  updateSharedGroups: () => unknown
): JSX.Element {
  return (
    <SmartHeroRow
      id={id}
      onHeightChange={onHeightChange}
      unblurAvatar={unblurAvatar}
      updateSharedGroups={updateSharedGroups}
    />
  );
}
function renderLoadingRow(id: string): JSX.Element {
  return <SmartTimelineLoadingRow id={id} />;
}
function renderTypingBubble(id: string): JSX.Element {
  return <SmartTypingBubble id={id} />;
}

const getWarning = (
  conversation: Readonly<ConversationType>,
  state: Readonly<StateType>
): undefined | TimelineWarningType => {
  switch (conversation.type) {
    case 'direct':
      if (!conversation.acceptedMessageRequest && !conversation.isBlocked) {
        const getConversationsWithTitle = getConversationsByTitleSelector(
          state
        );
        const conversationsWithSameTitle = getConversationsWithTitle(
          conversation.title
        );
        assert(
          conversationsWithSameTitle.length,
          'Expected at least 1 conversation with the same title (this one)'
        );

        const safeConversation = conversationsWithSameTitle.find(
          otherConversation =>
            otherConversation.acceptedMessageRequest &&
            otherConversation.type === 'direct' &&
            otherConversation.id !== conversation.id
        );

        if (safeConversation) {
          return {
            type: ContactSpoofingType.DirectConversationWithSameTitle,
            safeConversation,
          };
        }
      }
      return undefined;
    case 'group': {
      if (conversation.left || conversation.groupVersion !== 2) {
        return undefined;
      }

      const getConversationById = getConversationByIdSelector(state);

      const { memberships } = getGroupMemberships(
        conversation,
        getConversationById
      );
      const groupNameCollisions = getCollisionsFromMemberships(memberships);
      const hasGroupMembersWithSameName = !isEmpty(groupNameCollisions);
      if (hasGroupMembersWithSameName) {
        return {
          type: ContactSpoofingType.MultipleGroupMembersWithSameTitle,
          acknowledgedGroupNameCollisions:
            conversation.acknowledgedGroupNameCollisions || {},
          groupNameCollisions: dehydrateCollisionsWithConversations(
            groupNameCollisions
          ),
        };
      }

      return undefined;
    }
    default:
      throw missingCaseError(conversation.type);
  }
};

const getContactSpoofingReview = (
  selectedConversationId: string,
  state: Readonly<StateType>
): undefined | ContactSpoofingReviewPropType => {
  const { contactSpoofingReview } = state.conversations;
  if (!contactSpoofingReview) {
    return undefined;
  }

  const conversationSelector = getConversationSelector(state);
  const getConversationById = getConversationByIdSelector(state);

  const currentConversation = conversationSelector(selectedConversationId);

  switch (contactSpoofingReview.type) {
    case ContactSpoofingType.DirectConversationWithSameTitle:
      return {
        type: ContactSpoofingType.DirectConversationWithSameTitle,
        possiblyUnsafeConversation: currentConversation,
        safeConversation: conversationSelector(
          contactSpoofingReview.safeConversationId
        ),
      };
    case ContactSpoofingType.MultipleGroupMembersWithSameTitle: {
      const { memberships } = getGroupMemberships(
        currentConversation,
        getConversationById
      );
      const groupNameCollisions = getCollisionsFromMemberships(memberships);

      const previouslyAcknowledgedTitlesById = invertIdsByTitle(
        currentConversation.acknowledgedGroupNameCollisions || {}
      );

      const collisionInfoByTitle = mapValues(
        groupNameCollisions,
        conversations =>
          conversations.map(conversation => ({
            conversation,
            oldName: getOwn(previouslyAcknowledgedTitlesById, conversation.id),
          }))
      );

      return {
        type: ContactSpoofingType.MultipleGroupMembersWithSameTitle,
        collisionInfoByTitle,
      };
    }
    default:
      throw missingCaseError(contactSpoofingReview);
  }
};

const mapStateToProps = (state: StateType, props: ExternalProps) => {
  const { id, ...actions } = props;

  const conversation = getConversationSelector(state)(id);

  const conversationMessages = getConversationMessagesSelector(state)(id);
  const selectedMessage = getSelectedMessage(state);

  return {
    id,
    ...pick(conversation, [
      'areWeAdmin',
      'unreadCount',
      'typingContact',
      'isGroupV1AndDisabled',
    ]),
    isIncomingMessageRequest: Boolean(
      conversation.messageRequestsEnabled &&
        !conversation.acceptedMessageRequest
    ),
    ...conversationMessages,
    invitedContactsForNewlyCreatedGroup: getInvitedContactsForNewlyCreatedGroup(
      state
    ),
    selectedMessageId: selectedMessage ? selectedMessage.id : undefined,

    warning: getWarning(conversation, state),
    contactSpoofingReview: getContactSpoofingReview(id, state),

    i18n: getIntl(state),
    renderItem,
    renderLastSeenIndicator,
    renderHeroRow,
    renderLoadingRow,
    renderTypingBubble,
    ...actions,
  };
};

const smart = connect(mapStateToProps, mapDispatchToProps);

export const SmartTimeline = smart(Timeline);
