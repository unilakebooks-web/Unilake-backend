// will hold pronoun substitution 

import type { PronounKey } from "../../../generated/prisma/client.js";

type PronounSet = {
  subject: string;    // "he" / "she" / "they"
  object: string;     // "him" / "her" / "them"
  possessive: string; // "his" / "her" / "their"
};

const PRONOUN_TABLE: Record<PronounKey, PronounSet> = {
  HE:   { subject: "he",   object: "him",  possessive: "his" },
  SHE:  { subject: "she",  object: "her",  possessive: "her" },
  THEY: { subject: "they", object: "them", possessive: "their" },
};

export function getPronouns(key: PronounKey): PronounSet {
  return PRONOUN_TABLE[key];
}

/**
 * One piece of substituted dialogue. `isName` is true only for text that came
 * from a {name} token — that is what Bubble.nameColor paints. Pronouns are
 * ordinary dialogue and take the bubble's normal colour.
 */
export type DialogueSegment = {
  text: string;
  isName: boolean;
};

const TOKEN_PATTERN =
  /(\{name\}|\{pronoun_subject\}|\{pronoun_object\}|\{pronoun_possessive\})/;

/**
 * Substitute every token, but keep the result as pieces so the renderer still
 * knows which characters are the child's name after substitution.
 *
 * Splitting on a capturing group keeps the tokens in the output array, at the
 * odd indices. Every {name} is marked, not just the first. Adjacent plain
 * pieces are not merged — callers concatenate, so it would change nothing.
 */
export function substituteTokensToSegments(
  template: string,
  childName: string,
  pronounKey: PronounKey,
): DialogueSegment[] {
  const pronouns = getPronouns(pronounKey);

  return template
    .split(TOKEN_PATTERN)
    .filter((part) => part.length > 0)
    .map((part) => {
      switch (part) {
        case "{name}":
          return { text: childName, isName: true };
        case "{pronoun_subject}":
          return { text: pronouns.subject, isName: false };
        case "{pronoun_object}":
          return { text: pronouns.object, isName: false };
        case "{pronoun_possessive}":
          return { text: pronouns.possessive, isName: false };
        default:
          return { text: part, isName: false };
      }
    });
}