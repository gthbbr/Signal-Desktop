// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// State

export type GlobalModalsStateType = {
  readonly contactModalState?: ContactModalStateType;
  readonly isProfileEditorVisible: boolean;
  readonly profileEditorHasError: boolean;
};

// Actions

const HIDE_CONTACT_MODAL = 'globalModals/HIDE_CONTACT_MODAL';
const SHOW_CONTACT_MODAL = 'globalModals/SHOW_CONTACT_MODAL';
const TOGGLE_PROFILE_EDITOR = 'globalModals/TOGGLE_PROFILE_EDITOR';
export const TOGGLE_PROFILE_EDITOR_ERROR =
  'globalModals/TOGGLE_PROFILE_EDITOR_ERROR';

export type ContactModalStateType = {
  contactId: string;
  conversationId?: string;
};

type HideContactModalActionType = {
  type: typeof HIDE_CONTACT_MODAL;
};

type ShowContactModalActionType = {
  type: typeof SHOW_CONTACT_MODAL;
  payload: ContactModalStateType;
};

type ToggleProfileEditorActionType = {
  type: typeof TOGGLE_PROFILE_EDITOR;
};

export type ToggleProfileEditorErrorActionType = {
  type: typeof TOGGLE_PROFILE_EDITOR_ERROR;
};

export type GlobalModalsActionType =
  | HideContactModalActionType
  | ShowContactModalActionType
  | ToggleProfileEditorActionType
  | ToggleProfileEditorErrorActionType;

// Action Creators

export const actions = {
  hideContactModal,
  showContactModal,
  toggleProfileEditor,
  toggleProfileEditorHasError,
};

function hideContactModal(): HideContactModalActionType {
  return {
    type: HIDE_CONTACT_MODAL,
  };
}

function showContactModal(
  contactId: string,
  conversationId?: string
): ShowContactModalActionType {
  return {
    type: SHOW_CONTACT_MODAL,
    payload: {
      contactId,
      conversationId,
    },
  };
}

function toggleProfileEditor(): ToggleProfileEditorActionType {
  return { type: TOGGLE_PROFILE_EDITOR };
}

function toggleProfileEditorHasError(): ToggleProfileEditorErrorActionType {
  return { type: TOGGLE_PROFILE_EDITOR_ERROR };
}

// Reducer

export function getEmptyState(): GlobalModalsStateType {
  return {
    isProfileEditorVisible: false,
    profileEditorHasError: false,
  };
}

export function reducer(
  state: Readonly<GlobalModalsStateType> = getEmptyState(),
  action: Readonly<GlobalModalsActionType>
): GlobalModalsStateType {
  if (action.type === TOGGLE_PROFILE_EDITOR) {
    return {
      ...state,
      isProfileEditorVisible: !state.isProfileEditorVisible,
    };
  }

  if (action.type === TOGGLE_PROFILE_EDITOR_ERROR) {
    return {
      ...state,
      profileEditorHasError: !state.profileEditorHasError,
    };
  }

  if (action.type === SHOW_CONTACT_MODAL) {
    return {
      ...state,
      contactModalState: action.payload,
    };
  }

  if (action.type === HIDE_CONTACT_MODAL) {
    return {
      ...state,
      contactModalState: undefined,
    };
  }

  return state;
}
