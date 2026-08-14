/** Form state for governance actions. Kept out of the `"use server"` module. */

export type CreateProposalState = {
  error?: string;
  field?: string;
};

export const initialCreateProposalState: CreateProposalState = {};

export type VoteState = {
  message?: string;
  error?: string;
};

export const initialVoteState: VoteState = {};
