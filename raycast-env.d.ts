/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Brain Dump Directory - Directory path containing markdown brain dump files */
  "inboxDir": string,
  /** OpenAI API Key - Your OpenAI API key for task extraction */
  "openaiKey": string,
  /** OpenAI Model - OpenAI model to use for task extraction */
  "openaiModel": string,
  /** Notion Integration Token - Your Notion integration token */
  "notionToken": string,
  /** Notion Database ID - The ID of the Notion database to sync tasks to */
  "notionDbId": string,
  /** Enable Hourly Background Sync - Enable automatic hourly background synchronisation */
  "enableScheduled": boolean
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `runner-hourly` command */
  export type RunnerHourly = ExtensionPreferences & {}
  /** Preferences accessible in the `runner-manual` command */
  export type RunnerManual = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `runner-hourly` command */
  export type RunnerHourly = {}
  /** Arguments passed to the `runner-manual` command */
  export type RunnerManual = {}
}

