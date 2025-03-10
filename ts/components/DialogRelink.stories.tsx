// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { storiesOf } from '@storybook/react';
import { boolean } from '@storybook/addon-knobs';
import { action } from '@storybook/addon-actions';

import { DialogRelink } from './DialogRelink';
import { setupI18n } from '../util/setupI18n';
import enMessages from '../../_locales/en/messages.json';

const i18n = setupI18n('en', enMessages);

const defaultProps = {
  i18n,
  isRegistrationDone: true,
  relinkDevice: action('relink-device'),
};

const permutations = [
  {
    title: 'Unlinked',
    props: {
      isRegistrationDone: false,
    },
  },
];

storiesOf('Components/DialogRelink', module)
  .add('Knobs Playground', () => {
    const isRegistrationDone = boolean('isRegistrationDone', false);

    return (
      <DialogRelink {...defaultProps} isRegistrationDone={isRegistrationDone} />
    );
  })
  .add('Iterations', () => {
    return permutations.map(({ props, title }) => (
      <>
        <h3>{title}</h3>
        <DialogRelink {...defaultProps} {...props} />
      </>
    ));
  });
