// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The drive fixture page's entry (`drive-fixture.html`, served by `drive-fixture.serve.mjs`): mounts the made-up page
 * that lives beside the drive's specs. Not part of the app bundle.
 */
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DriveFixture, prepareFixture } from '../../packages/client/ui-layout/tests/drive-fixture/fixture.tsx'

const { world, chat } = prepareFixture(window.location.search)
const root = document.getElementById('drive-fixture-root')
if (root === null) throw new Error('drive fixture: #drive-fixture-root is missing')
createRoot(root).render(createElement(StrictMode, null, createElement(DriveFixture, { chat, world })))
