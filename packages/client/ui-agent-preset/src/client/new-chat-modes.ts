/**
 * THE NEW-CHAT MODE PICKER OFFERS ONE MODE: AUMA.
 *
 * On x6.1 a new chat starts as Auma, the `auma-alien` preset (her Alien Creator mode), shown as "Auma". The four stock
 * modes (Standard, PTC, Minimal, Creator: ids `standard`, `ptc`, `minimal`, `cordis`) are hidden from the PICKER only.
 * No preset is disabled or removed: every existing thread keeps the composition it was created with, stays listed and
 * readable, and keeps running in its own mode, because the host still knows every preset. Settings' preset management
 * still lists them all.
 *
 * When the roster has no `auma-alien` (a browser where her preset is not installed), nothing is hidden: an empty or
 * stock-less picker would leave a new chat on a mode nobody could see or change.
 * @module new-chat-modes
 */
import type { AgentPresetOption } from './settings-store.ts'

/** Her mode, the one a new chat offers. */
export const AUMA_MODE_ID = 'auma-alien'
/** How her mode is named in the picker. */
export const AUMA_MODE_LABEL = 'Auma'
/** The stock modes the picker hides when hers is present. */
export const STOCK_MODE_IDS: readonly string[] = Object.freeze(['standard', 'ptc', 'minimal', 'cordis'])

/**
 * The modes a new chat's picker offers.
 * @param options - every selectable preset the host listed.
 * @returns her mode alone, named "Auma", when the roster has it; otherwise the options unchanged.
 */
export function newChatModes(options: readonly AgentPresetOption[]): readonly AgentPresetOption[] {
  const auma = options.find(option => option.id === AUMA_MODE_ID)
  return auma === undefined ? options : [{ ...auma, name: AUMA_MODE_LABEL }]
}

/**
 * The mode a new chat starts in when nothing was picked.
 * @param presetIds - ids the host listed.
 * @param hostDefault - the host-effective default.
 * @returns her mode when the roster has it, else the host default.
 */
export function newChatDefaultMode(presetIds: readonly string[], hostDefault: string): string {
  return presetIds.includes(AUMA_MODE_ID) ? AUMA_MODE_ID : hostDefault
}

/**
 * The option to label the chip with: her mode is always named "Auma"; any other keeps its own copy.
 * @param option - the chosen option, if any.
 * @returns the option to render.
 */
export function newChatLabelOption(option: AgentPresetOption | undefined): AgentPresetOption | undefined {
  return option?.id === AUMA_MODE_ID ? { ...option, name: AUMA_MODE_LABEL } : option
}
