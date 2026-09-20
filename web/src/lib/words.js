/**
 * Word segmentation for the directors — the engine's own ICU
 * implementation of the Unicode algorithm, so it works in scripts written
 * without spaces (Japanese, Chinese, Thai) where splitting on whitespace
 * would return the whole sentence as one "word".
 *
 * Both directors send a line's words to the server and get back an INDEX
 * into this list — which word a head move lands on (face_director.js), or
 * which word a gesture's stroke lands on (motion_director.js). Keeping the
 * character offset here is what makes that index exact: the same word can
 * appear twice in a line ("no, no"), and searching the line for its text
 * would always find the first one.
 */

const SEGMENTER = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

/** The line's words with where each starts: [{ text, index }]. */
export function splitWords(line) {
    if (!SEGMENTER) return [];
    return [...SEGMENTER.segment(line)]
        .filter((s) => s.isWordLike)
        .map((s) => ({ text: s.segment, index: s.index }));
}
