// 错误域码与退出码映射。
// 契约出处：sdlc-contract §2（错误域/CLI 退码）；meegle-contract §4（meegle
// 信封错误码 → 域码映射在 meegle/runner.js，此处只管域码 → 退码）。
export const SCHEMA_VERSION = 5;

/** 域码 → CLI 退出码（v5：stage_version_conflict 原子占位语义随乐观锁退役） */
export const EXIT_BY_CODE = {
  unauthorized: 1,
  forbidden: 1,
  validation_failed: 1,
  id_ambiguous: 1,
  not_found: 1,
  target_invalid: 1,
  schema_unsupported: 3,
  external_unavailable: 2,
  external_unknown: 2,
};

/**
 * 统一错误：携带契约域码，main 据此映射退出码。
 * @property {string} code
 * @property {unknown} details
 */
export class SdlcError extends Error {
  /** @param {string} code 域码 @param {string} message @param {unknown} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'SdlcError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {SdlcError | ApiError} err
 * @returns {number} CLI 退出码（未知域码按 2 外部错误处理）
 */
export function exitCodeOf(err) {
  const code = /** @type {keyof typeof EXIT_BY_CODE} */ (err.code);
  return EXIT_BY_CODE[code] ?? 2;
}
