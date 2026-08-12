/**
 * Form state for the group actions.
 *
 * Lives outside `actions.ts` because a `"use server"` module may only export
 * async functions — see AGENTS.md.
 */

export type CreateGroupState = {
  error?: string;
  /** Which input the error belongs to, so the form can point at it. */
  field?: string;
};

export const initialCreateGroupState: CreateGroupState = {};

export type InviteState = {
  code?: string;
  expiresAt?: string;
  error?: string;
};

export const initialInviteState: InviteState = {};

export type MemberActionState = {
  message?: string;
  error?: string;
};

export const initialMemberActionState: MemberActionState = {};
