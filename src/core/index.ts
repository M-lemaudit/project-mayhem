/**
 * Core: browser automation (Playwright), sniper loop logic.
 * Phase 1: AuthService / SessionManager.
 * Phase 2: SniperLoop, FilterEngine, ActionService.
 */

export {
  AuthError,
  AuthCookie,
  AuthResult,
  DeepInspectionDebug,
  isSavedSessionUsable,
  SavedSession,
  loginAndGetToken,
} from './auth';
export { FilterEngine, BotFilters, OfferShape, MatchResult } from './filter-engine';
export { SniperLoop } from './sniper-loop';
