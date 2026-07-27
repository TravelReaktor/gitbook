/**
 * Global rules for the AI assistant.
 *
 * Each rule is a standing instruction prepended to every chat message (sent on the wire only, never
 * shown to the user). To add a new global rule, append an entry to `ASSISTANT_RULES`.
 *
 * Keep these to cross-cutting behaviour that should apply to EVERY answer. Rules specific to a single
 * tool (e.g. how to present a booking list) belong in that tool's description in `tools.ts`.
 */
export const ASSISTANT_RULES: string[] = [
    // Always link the documentation page(s) used (even for a small part of the answer), using each
    // page's own URL — never a URL found inside the page content. Non-documentation links only when
    // the user explicitly asks for them.
    'Whenever any part of your answer - even a small part - comes from the documentation, you MUST end ' +
        "your response with a link to each documentation page you used. Use the documentation page's own " +
        'URL (the page itself that you read/searched), and NEVER a URL found inside the page content. ' +
        'Only provide links that are NOT to the documentation (for example external or partner links, ' +
        'such as an airline site) when the user explicitly asks for that kind of link; otherwise do not ' +
        'include them.',
];

/**
 * Serialize the rules into a preamble to prepend to the user's message. Returns an empty string when
 * there are no rules.
 */
export function serializeAssistantRules(): string {
    if (ASSISTANT_RULES.length === 0) {
        return '';
    }

    return `${ASSISTANT_RULES.join('\n\n')}\n\n---\n\n`;
}
