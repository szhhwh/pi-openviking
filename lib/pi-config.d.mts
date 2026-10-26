/**
 * Types for `pi-config.mjs`. `config.ts` is the typed view; this declaration
 * keeps the two from drifting and lets the sidecar helpers typecheck.
 */
import type { OVConfig } from "../config.js";

export const EXTENSION_ROOT: string;
export const EXTENSION_VERSION: string;
export const PI_SETTINGS_PATH: string;
export const DEFAULT_DEBUG_LOG_PATH: string;
export const STATUS_BAR_LEVELS: readonly ["hidden", "minimal", "standard", "verbose"];
export const PI_UI_KEYS: readonly string[];

export function normalizeStatusBarLevel(value: unknown): "hidden" | "minimal" | "standard" | "verbose";
export function readSettingsSidecar(): Partial<OVConfig>;
export function resolvePiConfig(options?: { cwd?: string; applySidecar?: boolean }): OVConfig;
export function savePiConfig(config: OVConfig, keys?: readonly string[]): boolean;
