// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import React, { useState, ReactNode } from 'react';

import { ConversationType } from '../../../state/ducks/conversations';
import { assert } from '../../../util/assert';
import { getMutedUntilText } from '../../../util/getMutedUntilText';

import { LocalizerType } from '../../../types/Util';
import { MediaItemType } from '../../../types/MediaItem';
import { CapabilityError } from '../../../types/errors';
import { missingCaseError } from '../../../util/missingCaseError';

import { DisappearingTimerSelect } from '../../DisappearingTimerSelect';

import { PanelRow } from './PanelRow';
import { PanelSection } from './PanelSection';
import { AddGroupMembersModal } from './AddGroupMembersModal';
import { ConversationDetailsActions } from './ConversationDetailsActions';
import { ConversationDetailsHeader } from './ConversationDetailsHeader';
import { ConversationDetailsIcon } from './ConversationDetailsIcon';
import { ConversationDetailsMediaList } from './ConversationDetailsMediaList';
import {
  ConversationDetailsMembershipList,
  GroupV2Membership,
} from './ConversationDetailsMembershipList';
import {
  GroupV2PendingMembership,
  GroupV2RequestingMembership,
} from './PendingInvites';
import { EditConversationAttributesModal } from './EditConversationAttributesModal';
import { RequestState } from './util';
import { getCustomColorStyle } from '../../../util/getCustomColorStyle';
import { ConfirmationDialog } from '../../ConfirmationDialog';
import {
  AvatarDataType,
  DeleteAvatarFromDiskActionType,
  ReplaceAvatarActionType,
  SaveAvatarToDiskActionType,
} from '../../../types/Avatar';

enum ModalState {
  NothingOpen,
  EditingGroupDescription,
  EditingGroupTitle,
  AddingGroupMembers,
}

export type StateProps = {
  addMembers: (conversationIds: ReadonlyArray<string>) => Promise<void>;
  canEditGroupInfo: boolean;
  candidateContactsToAdd: Array<ConversationType>;
  conversation?: ConversationType;
  hasGroupLink: boolean;
  i18n: LocalizerType;
  isAdmin: boolean;
  loadRecentMediaItems: (limit: number) => void;
  memberships: Array<GroupV2Membership>;
  pendingApprovalMemberships: ReadonlyArray<GroupV2RequestingMembership>;
  pendingMemberships: ReadonlyArray<GroupV2PendingMembership>;
  setDisappearingMessages: (seconds: number) => void;
  showAllMedia: () => void;
  showGroupChatColorEditor: () => void;
  showGroupLinkManagement: () => void;
  showGroupV2Permissions: () => void;
  showPendingInvites: () => void;
  showLightboxForMedia: (
    selectedMediaItem: MediaItemType,
    media: Array<MediaItemType>
  ) => void;
  showConversationNotificationsSettings: () => void;
  updateGroupAttributes: (
    _: Readonly<{
      avatar?: undefined | ArrayBuffer;
      description?: string;
      title?: string;
    }>
  ) => Promise<void>;
  onBlock: () => void;
  onLeave: () => void;
  userAvatarData: Array<AvatarDataType>;
};

type ActionProps = {
  deleteAvatarFromDisk: DeleteAvatarFromDiskActionType;
  replaceAvatar: ReplaceAvatarActionType;
  saveAvatarToDisk: SaveAvatarToDiskActionType;
  showContactModal: (contactId: string, conversationId: string) => void;
};

export type Props = StateProps & ActionProps;

export const ConversationDetails: React.ComponentType<Props> = ({
  addMembers,
  canEditGroupInfo,
  candidateContactsToAdd,
  conversation,
  hasGroupLink,
  i18n,
  isAdmin,
  loadRecentMediaItems,
  memberships,
  pendingApprovalMemberships,
  pendingMemberships,
  setDisappearingMessages,
  showAllMedia,
  showContactModal,
  showGroupChatColorEditor,
  showGroupLinkManagement,
  showGroupV2Permissions,
  showPendingInvites,
  showLightboxForMedia,
  showConversationNotificationsSettings,
  updateGroupAttributes,
  onBlock,
  onLeave,
  deleteAvatarFromDisk,
  replaceAvatar,
  saveAvatarToDisk,
  userAvatarData,
}) => {
  const [modalState, setModalState] = useState<ModalState>(
    ModalState.NothingOpen
  );
  const [
    editGroupAttributesRequestState,
    setEditGroupAttributesRequestState,
  ] = useState<RequestState>(RequestState.Inactive);
  const [
    addGroupMembersRequestState,
    setAddGroupMembersRequestState,
  ] = useState<RequestState>(RequestState.Inactive);
  const [membersMissingCapability, setMembersMissingCapability] = useState(
    false
  );

  if (conversation === undefined) {
    throw new Error('ConversationDetails rendered without a conversation');
  }

  const invitesCount =
    pendingMemberships.length + pendingApprovalMemberships.length;

  const otherMemberships = memberships.filter(({ member }) => !member.isMe);
  const isJustMe = otherMemberships.length === 0;
  const isAnyoneElseAnAdmin = otherMemberships.some(
    membership => membership.isAdmin
  );
  const cannotLeaveBecauseYouAreLastAdmin =
    isAdmin && !isJustMe && !isAnyoneElseAnAdmin;

  let modalNode: ReactNode;
  switch (modalState) {
    case ModalState.NothingOpen:
      modalNode = undefined;
      break;
    case ModalState.EditingGroupDescription:
    case ModalState.EditingGroupTitle:
      modalNode = (
        <EditConversationAttributesModal
          avatarColor={conversation.color}
          avatarPath={conversation.avatarPath}
          conversationId={conversation.id}
          groupDescription={conversation.groupDescription}
          i18n={i18n}
          initiallyFocusDescription={
            modalState === ModalState.EditingGroupDescription
          }
          makeRequest={async (
            options: Readonly<{
              avatar?: undefined | ArrayBuffer;
              description?: string;
              title?: string;
            }>
          ) => {
            setEditGroupAttributesRequestState(RequestState.Active);

            try {
              await updateGroupAttributes(options);
              setModalState(ModalState.NothingOpen);
              setEditGroupAttributesRequestState(RequestState.Inactive);
            } catch (err) {
              setEditGroupAttributesRequestState(
                RequestState.InactiveWithError
              );
            }
          }}
          onClose={() => {
            setModalState(ModalState.NothingOpen);
            setEditGroupAttributesRequestState(RequestState.Inactive);
          }}
          requestState={editGroupAttributesRequestState}
          title={conversation.title}
          deleteAvatarFromDisk={deleteAvatarFromDisk}
          replaceAvatar={replaceAvatar}
          saveAvatarToDisk={saveAvatarToDisk}
          userAvatarData={userAvatarData}
        />
      );
      break;
    case ModalState.AddingGroupMembers:
      modalNode = (
        <AddGroupMembersModal
          candidateContacts={candidateContactsToAdd}
          clearRequestError={() => {
            setAddGroupMembersRequestState(oldRequestState => {
              assert(
                oldRequestState !== RequestState.Active,
                'Should not be clearing an active request state'
              );
              return RequestState.Inactive;
            });
          }}
          conversationIdsAlreadyInGroup={
            new Set(memberships.map(membership => membership.member.id))
          }
          groupTitle={conversation.title}
          i18n={i18n}
          makeRequest={async conversationIds => {
            setAddGroupMembersRequestState(RequestState.Active);

            try {
              await addMembers(conversationIds);
              setModalState(ModalState.NothingOpen);
              setAddGroupMembersRequestState(RequestState.Inactive);
            } catch (err) {
              if (err instanceof CapabilityError) {
                setMembersMissingCapability(true);
                setAddGroupMembersRequestState(RequestState.InactiveWithError);
              } else {
                setAddGroupMembersRequestState(RequestState.InactiveWithError);
              }
            }
          }}
          onClose={() => {
            setModalState(ModalState.NothingOpen);
            setEditGroupAttributesRequestState(RequestState.Inactive);
          }}
          requestState={addGroupMembersRequestState}
        />
      );
      break;
    default:
      throw missingCaseError(modalState);
  }

  return (
    <div className="conversation-details-panel">
      {membersMissingCapability && (
        <ConfirmationDialog
          cancelText={i18n('Confirmation--confirm')}
          i18n={i18n}
          onClose={() => setMembersMissingCapability(false)}
        >
          {i18n('GroupV2--add--missing-capability')}
        </ConfirmationDialog>
      )}

      <ConversationDetailsHeader
        canEdit={canEditGroupInfo}
        conversation={conversation}
        i18n={i18n}
        memberships={memberships}
        startEditing={(isGroupTitle: boolean) => {
          setModalState(
            isGroupTitle
              ? ModalState.EditingGroupTitle
              : ModalState.EditingGroupDescription
          );
        }}
      />

      <PanelSection>
        {canEditGroupInfo ? (
          <PanelRow
            icon={
              <ConversationDetailsIcon
                ariaLabel={i18n(
                  'ConversationDetails--disappearing-messages-label'
                )}
                icon="timer"
              />
            }
            info={i18n('ConversationDetails--disappearing-messages-info')}
            label={i18n('ConversationDetails--disappearing-messages-label')}
            right={
              <DisappearingTimerSelect
                i18n={i18n}
                value={conversation.expireTimer || 0}
                onChange={setDisappearingMessages}
              />
            }
          />
        ) : null}
        <PanelRow
          icon={
            <ConversationDetailsIcon
              ariaLabel={i18n('showChatColorEditor')}
              icon="color"
            />
          }
          label={i18n('showChatColorEditor')}
          onClick={showGroupChatColorEditor}
          right={
            <div
              className={`module-conversation-details__chat-color module-conversation-details__chat-color--${conversation.conversationColor}`}
              style={{
                ...getCustomColorStyle(conversation.customColor),
              }}
            />
          }
        />
        <PanelRow
          icon={
            <ConversationDetailsIcon
              ariaLabel={i18n('ConversationDetails--notifications')}
              icon="notifications"
            />
          }
          label={i18n('ConversationDetails--notifications')}
          onClick={showConversationNotificationsSettings}
          right={
            conversation.muteExpiresAt
              ? getMutedUntilText(conversation.muteExpiresAt, i18n)
              : undefined
          }
        />
      </PanelSection>

      <ConversationDetailsMembershipList
        canAddNewMembers={canEditGroupInfo}
        conversationId={conversation.id}
        i18n={i18n}
        memberships={memberships}
        showContactModal={showContactModal}
        startAddingNewMembers={() => {
          setModalState(ModalState.AddingGroupMembers);
        }}
      />

      <PanelSection>
        {isAdmin || hasGroupLink ? (
          <PanelRow
            icon={
              <ConversationDetailsIcon
                ariaLabel={i18n('ConversationDetails--group-link')}
                icon="link"
              />
            }
            label={i18n('ConversationDetails--group-link')}
            onClick={showGroupLinkManagement}
            right={hasGroupLink ? i18n('on') : i18n('off')}
          />
        ) : null}
        <PanelRow
          icon={
            <ConversationDetailsIcon
              ariaLabel={i18n('ConversationDetails--requests-and-invites')}
              icon="invites"
            />
          }
          label={i18n('ConversationDetails--requests-and-invites')}
          onClick={showPendingInvites}
          right={invitesCount}
        />
        {isAdmin ? (
          <PanelRow
            icon={
              <ConversationDetailsIcon
                ariaLabel={i18n('permissions')}
                icon="lock"
              />
            }
            label={i18n('permissions')}
            onClick={showGroupV2Permissions}
          />
        ) : null}
      </PanelSection>

      <ConversationDetailsMediaList
        conversation={conversation}
        i18n={i18n}
        loadRecentMediaItems={loadRecentMediaItems}
        showAllMedia={showAllMedia}
        showLightboxForMedia={showLightboxForMedia}
      />

      <ConversationDetailsActions
        i18n={i18n}
        cannotLeaveBecauseYouAreLastAdmin={cannotLeaveBecauseYouAreLastAdmin}
        conversationTitle={conversation.title}
        left={Boolean(conversation.left)}
        onLeave={onLeave}
        onBlock={onBlock}
      />

      {modalNode}
    </div>
  );
};
