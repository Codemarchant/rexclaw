// English for the Japanese blend shape names that MMD's standard face set
// defines (and that most Booth / VRChat avatars carry, SoulFlame VRM
// Exporter keeping them by name), so the Tune face pickers can be read and
// searched without Japanese. Shown beside the name, never instead of it.
const MMD_NAMES = {
    // Brows (眉)
    "真面目": "serious brows",
    "困る": "worried brows",
    "にこり": "smiling brows",
    "怒り": "angry brows",
    "上": "brows up",
    "下": "brows down",
    // Eyes (目)
    "まばたき": "blink",
    "笑い": "smiling eyes (closed)",
    "ウィンク": "wink",
    "ウィンク右": "wink (right)",
    "ウィンク２": "wink 2",
    "ｳｨﾝｸ２右": "wink 2 (right)",
    "ウィンク２右": "wink 2 (right)",
    "なごみ": "soft eyes",
    "はぅ": "> < eyes",
    "びっくり": "surprised eyes",
    "じと目": "half-lidded stare",
    "ｷﾘｯ": "sharp eyes",
    "キリッ": "sharp eyes",
    "はちゅ目": "dot eyes",
    "星目": "star eyes",
    "はぁと": "heart eyes",
    "瞳小": "small pupils",
    "瞳大": "big pupils",
    "瞳縦潰れ": "squashed pupils",
    "ハイライト消し": "no eye highlights",
    "映り込み消し": "no eye reflections",
    "喜び": "joyful eyes",
    "悲しむ": "sad eyes",
    "恐ろしい子！": "shocked eyes",
    // Mouth (口)
    "あ": "mouth A",
    "あ２": "mouth A (wide)",
    "い": "mouth I",
    "う": "mouth U",
    "え": "mouth E",
    "お": "mouth O",
    "ん": "mouth N (closed)",
    "ワ": "open mouth (wa)",
    "ω": "cat mouth ω",
    "ω□": "open cat mouth",
    "▲": "triangle mouth",
    "∧": "pout ∧",
    "□": "square mouth",
    "にやり": "smirk",
    "にやり２": "smirk 2",
    "にやり2": "smirk 2",
    "にっこり": "grin",
    "ぺろっ": "tongue out",
    "てへぺろ": "tongue out (teehee)",
    "口角上げ": "mouth corners up",
    "口角下げ": "mouth corners down",
    "口横広げ": "mouth wide",
    "歯無し上": "no upper teeth",
    "歯無し下": "no lower teeth",
    // Other
    "照れ": "blush",
    "赤面": "blush (red face)",
    "頬染め": "blush",
    "青ざめ": "pale (gloom)",
    "涙": "tears",
    "がーん": "shock lines",
};

/** English for a blend shape's name, or "" when there is none to add. */
export function morphHint(name) {
    return MMD_NAMES[name] || "";
}

/** A blend shape as a picker shows it: "はぁと — heart eyes". */
export function morphLabel(name) {
    const hint = morphHint(name);
    return hint ? `${name} — ${hint}` : name;
}
