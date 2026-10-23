// The toy box: what can be dropped in for the companion to play with, by
// tray category. Each toy is a sphere to the physics (models/toys/physics.js)
// with its real size and weight; `kind` picks what the companion does with
// it (models/toys/brains.js) and how the stages treat it (gadgets that blow,
// glow or smoke). Sizes, weights and bounces come from the cited standards
// and portion tables where one exists; the others say "by eye".

export const TOY_CATEGORIES = [
    { id: "treats", label: "Treats", icon: "fa-cutlery" },
    { id: "play", label: "Toys", icon: "fa-futbol-o" },
    { id: "gadgets", label: "Gadgets", icon: "fa-magic" },
    { id: "lights", label: "Lights", icon: "fa-lightbulb-o" },
    { id: "crew", label: "Crew", icon: "fa-anchor" },
];

/** Coefficient of restitution from a drop test: dropped from h0, back up
 *  to h1 (both to the same point of the ball). */
const fromDrop = (h0, h1) => Math.sqrt(h1 / h0);

// Light colours: a blackbody's colour at each temperature (Mitchell
// Charity's blackbody colour table, CIE 1964 10° with a D65 white point).
const K1900 = "#ff8300", K2200 = "#ff932c", K2700 = "#ffa957", K5000 = "#ffe4ce";

// How a treat is eaten (brains.js): "bite" (in both hands, a mouthful at a
// time), "pop" (one go, into the mouth), "peel" (peeled first), "lick",
// "catch" (tossed up and caught in the mouth), "slurp" (noodles off
// chopsticks), "sip" (a hot drink, slowly), "swig" (a coffee to go),
// "bottle" (opened and gulped). `off`: what that one is like when it has
// gone off (for the companion's note; most never do, brains.js OFF_ODDS).
export const TOYS = {
    // ── treats: walked over to, picked up and eaten ─────────────────────
    donut: {
        cat: "treats", name: "Donut", kind: "food", note: "a pink frosted donut",
        // A medium glazed doughnut, 3¾ in across, 60 g (USDA FoodData
        // Central); its bounce by eye.
        radius: 0.048, mass: 0.06, restitution: 0.15, slides: false,
        art: { w: 0.096, h: 0.096 }, food: { bites: 4, crumbs: "#d6a35c", style: "bite", off: "stale" },
    },
    strawberry: {
        cat: "treats", name: "Strawberry", kind: "food", note: "a strawberry",
        // A medium strawberry, 1¼ in across, 12 g (USDA FoodData Central).
        radius: 0.016, mass: 0.012, restitution: 0.2,
        art: { w: 0.04, h: 0.04 }, food: { bites: 1, crumbs: "#e11d48", style: "pop", off: "mushy" },
    },
    grape: {
        cat: "treats", name: "Grape", kind: "food", note: "a grape",
        // One table grape: 10 grapes are 49 g (USDA FoodData Central, red or
        // green grapes), so 4.9 g; about 2 cm long (by eye).
        radius: 0.011, mass: 0.0049, restitution: 0.35,
        art: { w: 0.03, h: 0.03 }, food: { bites: 1, crumbs: "#a855f7", style: "catch", off: "sour" },
    },
    chili: {
        // (Told as just a chili: how hot is the surprise when it hits,
        // brains.js spicy.)
        cat: "treats", name: "Hot pepper", kind: "food", note: "a chili pepper",
        // One hot chili pepper, 45 g (USDA FoodData Central portion); the
        // drawing is its length.
        radius: 0.025, mass: 0.045, restitution: 0.2,
        art: { w: 0.09, h: 0.09 }, food: { bites: 1, crumbs: "#dc2626", spicy: true, style: "bite" },
    },
    apple: {
        cat: "treats", name: "Apple", kind: "food", note: "a red apple", spins: true,
        // A medium apple, 3 in across, 182 g (USDA FoodData Central); its
        // bounce by eye.
        radius: 0.038, mass: 0.182, restitution: 0.3,
        art: { w: 0.084, h: 0.084 }, food: { bites: 4, crumbs: "#fef3c7", style: "bite", crunch: true, off: "bruised and mealy" },
    },
    banana: {
        cat: "treats", name: "Banana", kind: "food", note: "a banana", tumbles: true,
        // A medium banana, 7 to 7⅞ in long, 118 g (USDA FoodData Central).
        radius: 0.03, mass: 0.118, restitution: 0.15,
        art: { w: 0.19, h: 0.19 }, food: { bites: 3, crumbs: "#fde68a", style: "peel", off: "brown and mushy" },
    },
    icecream: {
        cat: "treats", name: "Ice cream", kind: "food", note: "a vanilla ice cream cone",
        // A scoop of vanilla ice cream, ½ cup, 66 g, on a 4 g cake cone
        // (USDA FoodData Central); about 12 cm tall (by eye).
        radius: 0.045, mass: 0.07, restitution: 0.05,
        art: { w: 0.12, h: 0.12 }, food: { bites: 2, licks: 5, crumbs: "#fef3c7", style: "lick", cold: true, off: "freezer-burnt" },
    },
    cupcake: {
        cat: "treats", name: "Cupcake", kind: "food", note: "a strawberry cupcake",
        // A bakery cupcake, about 7 cm across and 60 g (by eye).
        radius: 0.04, mass: 0.06, restitution: 0.1,
        art: { w: 0.09, h: 0.09 }, food: { bites: 3, crumbs: "#f9a8d4", style: "bite", off: "stale" },
    },
    noodles: {
        cat: "treats", name: "Noodles", kind: "food", note: "a bowl of noodles with chopsticks",
        // A cup of cooked egg noodles, 160 g (USDA FoodData Central), with
        // some broth in a 12 cm bowl, about 350 g in all (by eye).
        radius: 0.06, mass: 0.35, restitution: 0.05, vessel: true,
        art: { w: 0.14, h: 0.14 }, food: { bites: 5, crumbs: "#fde68a", style: "slurp", hot: true, off: "cold and soggy" },
    },
    tea: {
        cat: "treats", name: "Tea", kind: "food", note: "a mug of hot tea", vessel: true,
        // A mug: a cup of brewed tea is 237 g (USDA FoodData Central), in a
        // 300 g stoneware mug (by eye), 9 cm tall.
        radius: 0.045, mass: 0.54, restitution: 0.05,
        art: { w: 0.11, h: 0.11 }, food: { bites: 6, crumbs: "#b45309", style: "sip", hot: true, off: "stewed and cold" },
    },
    coffee: {
        cat: "treats", name: "Coffee", kind: "food", note: "a takeaway coffee", vessel: true,
        // A 12 fl oz takeaway cup: 355 ml of brewed coffee, about 355 g, in
        // a 15 g paper cup (by eye); 13 cm tall.
        radius: 0.045, mass: 0.37, restitution: 0.05,
        art: { w: 0.13, h: 0.13 }, food: { bites: 3, crumbs: "#78350f", style: "swig", hot: true, wired: true, off: "burnt" },
    },
    water: {
        cat: "treats", name: "Water bottle", kind: "food", note: "a bottle of water", tumbles: true, vessel: true,
        // A 500 ml bottle (500 g of water) in a 10 g plastic bottle (by
        // eye), 20 cm tall.
        radius: 0.035, mass: 0.51, restitution: 0.25,
        art: { w: 0.2, h: 0.2, cy: 0.065 }, food: { bites: 4, crumbs: "#7dd3fc", style: "bottle" },
    },

    // ── play ────────────────────────────────────────────────────────────
    basketball: {
        cat: "play", name: "Basketball", kind: "ball", note: "a basketball", shell: true, spins: true,
        // FIBA's size 5 ball (the mini-basketball one): 685-700 mm round,
        // 465-495 g. Its bounce from FIBA's ball test: dropped from
        // 1,800 mm, back up to 1,035-1,085 mm (both to its underside).
        // FIBA Official Basketball Rules 2026, Basketball Equipment §2.4.
        radius: 0.11, mass: 0.48, restitution: fromDrop(1.8, 1.06),
        art: { w: 0.222, h: 0.222 }, hoop: true,
    },
    football: {
        cat: "play", name: "Football", kind: "ball", note: "a football (soccer ball)", shell: true, spins: true,
        // The Laws of the Game's ball: 68-70 cm round, 410-450 g (IFAB Law
        // 2). Its bounce from a FIFA Basic ball's rebound spec: dropped from
        // 2 m, back up 1.25-1.55 m — the middle of that.
        radius: 0.11, mass: 0.43, restitution: fromDrop(2.0, 1.4),
        art: { w: 0.22, h: 0.22 }, goal: true,
    },
    rugby: {
        cat: "play", name: "Rugby ball", kind: "ball", note: "a rugby ball", spins: true, tumbles: true,
        // World Rugby Law 2: 280-300 mm long, 740-770 mm round end to end,
        // 580-620 mm round the middle, 410-460 g. Its physics is a sphere as
        // wide as its middle (600 mm round); `long` is how much longer it is
        // drawn. Its bounce by eye (and anything but true).
        radius: 0.095, mass: 0.435, restitution: 0.55, long: 0.145 / 0.095,
        art: { w: 0.3, h: 0.3 }, posts: true,
    },
    wand: {
        cat: "play", name: "Bubble wand", kind: "wand", note: "a bubble wand",
        radius: 0.08, mass: 0.04, restitution: 0.3,
        art: { w: 0.18, h: 0.18 },
    },

    // ── gadgets: switched on with a click; they blow, smoke and sparkle ──
    fan: {
        cat: "gadgets", name: "Fan", kind: "fan", note: "an electric fan", gadget: true,
        // A 16 in (0.41 m) pedestal fan blowing 1 m/s at whoever stands in
        // front of it: the higher of the two desk-fan speeds a thermal
        // comfort study gave its sitters (LSU). Mass by eye.
        // Its physics is its round base; the head stands 1.2 m up (Shift +
        // scroll raises and lowers the stand between `headRange`, by eye)
        // and tilts to whoever is in front of it.
        radius: 0.18, mass: 5, restitution: 0.05, slides: true, headY: 1.2, headRange: [0.55, 1.6],
        art: { w: 0.5, h: 1.5, cy: 0.57 }, jet: { d: 0.41, u0: 1.0 },
    },
    dryer: {
        cat: "gadgets", name: "Hair dryer", kind: "dryer", note: "a hair dryer", gadget: true, hovers: true,
        // Fitted to a lab's hair dryer measured on high: 7.3 m/s 10 cm out,
        // 6.4 m/s at 15 cm, falling off as a jet does (ASEE paper 46692).
        radius: 0.12, mass: 0.6, restitution: 0.1,
        art: { w: 0.26, h: 0.26 }, jet: { d: 0.035, u0: 7.3 },
    },
    fogger: {
        cat: "gadgets", name: "Smoke machine", kind: "fogger", note: "a smoke machine", gadget: true,
        radius: 0.13, mass: 4, restitution: 0.05, slides: true,
        art: { w: 0.34, h: 0.34 },
    },
    disco: {
        cat: "gadgets", name: "Disco ball", kind: "disco", note: "a disco ball", gadget: true, hovers: true,
        // A 12 in (0.3 m) mirror ball.
        radius: 0.15, mass: 1.2, restitution: 0.1,
        art: { w: 0.3, h: 0.3 },
    },

    // ── lights: set down about the room, clicked on and off, scrolled
    // over for another shade. `lamp`: the bulb's lumens, its colour, where
    // it sits from the toy's centre (m), how much of its light comes
    // through the shade in the shade's colour (`tint`), a spot's cone and
    // whether it flickers (a flame) or twinkles. Lumens are ENERGY STAR's
    // equivalents for a household bulb (40 W: 450 lm, 75 W: 1,100 lm)
    // where the lamp takes one; a candle is 1 candela (the unit
    // began as one), ≈12.6 lm all round. `grab`: extra spots to pick a
    // tall lamp up by, [height above its centre, radius] (m). `shades`:
    // what the wheel steps through; `light` overrides the light's colour.
    // `hang`: how high a hanging one goes up (its centre, m; by eye). `sound`:
// the loop it plays while it's on (sfx.js).
    desk: {
        cat: "lights", name: "Desk lamp", kind: "lamp", note: "a desk lamp on a little desk", gadget: true, placed: true, slides: true,
        // A small desk, 1.0 × 0.5 m, its top 0.75 m up (a usual desk
        // height); an angled lamp on it with a 40 W-equivalent bulb.
        radius: 0.375, mass: 25, restitution: 0.02,
        art: { w: 1.05, h: 1.25, cy: 0.25 }, grab: [[0.3, 0.45], [0.7, 0.2]],
        lamp: { lm: 450, color: K2700, at: [0.28, 0.8, 0.02], spot: 70, tint: 0 },
        shades: [{ name: "Red", color: "#dc2626" }, { name: "Black", color: "#1f2937" },
            { name: "Cream", color: "#efe6d2" }, { name: "Mint", color: "#5eead4" }],
    },
    floorlamp: {
        cat: "lights", name: "Floor lamp", kind: "lamp", note: "a floor lamp with a fabric shade", gadget: true, placed: true, slides: true,
        // 1.6 m tall with a 40 cm drum shade (by eye), a 75 W-equivalent
        // bulb; half its light out of the shade's open top and bottom, half
        // through the fabric (by eye).
        radius: 0.16, mass: 6, restitution: 0.02,
        art: { w: 0.5, h: 1.65, cy: 0.66 }, grab: [[0.7, 0.1], [1.3, 0.25]],
        lamp: { lm: 1100, color: K2700, at: [0, 1.32, 0], tint: 0.5 },
        shades: [{ name: "Linen", color: "#efe6d2" }, { name: "Sage", color: "#a3b18a" },
            { name: "Terracotta", color: "#c8714e" }, { name: "Navy", color: "#2b3a67" }],
    },
    lantern: {
        cat: "lights", name: "Paper lantern", kind: "lamp", note: "a round paper lantern", gadget: true, placed: true, hovers: true,
        // A 40 cm paper globe (by eye) round a 40 W-equivalent bulb; nearly
        // all the light comes through the paper.
        radius: 0.2, mass: 0.3, restitution: 0.2, hang: 1.9,
        art: { w: 0.42, h: 0.62, cy: 0.1 },
        lamp: { lm: 450, color: K2700, at: [0, 0, 0], tint: 0.85 },
        shades: [{ name: "White", color: "#fbf7ef" }, { name: "Blush", color: "#f9c6d3" },
            { name: "Butter", color: "#fde68a" }, { name: "Sky", color: "#bfdbfe" }],
    },
    lava: {
        cat: "lights", name: "Lava lamp", kind: "lamp", note: "a lava lamp", gadget: true, placed: true, slides: true,
        // 40 cm tall (by eye); a small bulb under coloured liquid, so a dim,
        // deep glow (by eye).
        radius: 0.07, mass: 2, restitution: 0.05,
        art: { w: 0.16, h: 0.42, cy: 0.13 }, grab: [[0.15, 0.08]],
        lamp: { lm: 40, color: K2700, at: [0, 0.15, 0], tint: 1 },
        shades: [{ name: "Magma", color: "#e11d48", wax: "#ff7a1a", light: "#ff5a2a" },
            { name: "Grape", color: "#4c1d95", wax: "#e879f9", light: "#b45cf0" },
            { name: "Ocean", color: "#1d4ed8", wax: "#67e8f9", light: "#3b9bff" },
            { name: "Lime", color: "#0f766e", wax: "#bef264", light: "#5ee08a" }],
    },
    candles: {
        cat: "lights", name: "Candles", kind: "lamp", note: "three candles on a little side table", gadget: true, placed: true, slides: true,
        // A 55 cm side table (by eye) with three pillar candles; a candle
        // flame is about 1,850 K.
        radius: 0.2, mass: 6, restitution: 0.02,
        art: { w: 0.42, h: 0.78, cy: 0.18 }, grab: [[0.4, 0.15]],
        lamp: { lm: 3 * 12.6, color: K1900, at: [0, 0.46, 0], tint: 0, flicker: true },
        shades: [{ name: "Ivory", color: "#f5efe0" }, { name: "Rose", color: "#f4c2c2" },
            { name: "Sage", color: "#b5c99a" }, { name: "Plum", color: "#7c3f6e" }],
    },
    jar: {
        cat: "lights", name: "Fairy-light jar", kind: "lamp", note: "a jar full of fairy lights", gadget: true, placed: true,
        // A big jar, 25 cm (by eye), stuffed with a string of tiny LEDs
        // (dim: by eye).
        radius: 0.07, mass: 0.8, restitution: 0.1,
        art: { w: 0.16, h: 0.26, cy: 0.06 },
        lamp: { lm: 60, color: K2200, at: [0, 0.02, 0], tint: 0, twinkle: true },
        shades: [{ name: "Warm", color: K2200, light: K2200 }, { name: "Cool", color: K5000, light: K5000 },
            { name: "Rainbow", color: "#f472b6", light: "#ffd6f0", rainbow: true }, { name: "Pink", color: "#f9a8d4", light: "#ff9fd0" }],
    },
    moon: {
        cat: "lights", name: "Moon lamp", kind: "lamp", note: "a glowing moon lamp", gadget: true, placed: true, hovers: true,
        // A 20 cm moon (by eye) lit from inside by LEDs (dim: by eye).
        radius: 0.1, mass: 0.4, restitution: 0.1, hang: 1.5,
        art: { w: 0.22, h: 0.22 },
        lamp: { lm: 80, color: K2700, at: [0, 0, 0], tint: 1 },
        shades: [{ name: "Warm", color: "#ffe2b8", light: K2700 }, { name: "Daylight", color: "#f1f5f9", light: K5000 },
            { name: "Blue", color: "#bfdbfe", light: "#93c5fd" }, { name: "Rose", color: "#fecdd3", light: "#fda4af" }],
    },
    neon: {
        cat: "lights", name: "Neon sign", kind: "lamp", note: "a glowing Rexclaw neon sign", gadget: true, placed: true, hovers: true,
        // 90 × 30 cm (by eye), hung up behind them; neon's own colours.
        radius: 0.15, mass: 2, restitution: 0.1, hang: 1.8,
        art: { w: 0.9, h: 0.3 }, grab: [[0, 0.3]],
        lamp: { lm: 150, color: "#ff4fd8", at: [0, 0, 0.05], tint: 1 },
        shades: [{ name: "Pink", color: "#ff4fd8", light: "#ff4fd8" }, { name: "Cyan", color: "#22d3ee", light: "#22d3ee" },
            { name: "Red", color: "#ff3355", light: "#ff3355" }, { name: "Lime", color: "#a3ff3d", light: "#a3ff3d" }],
    },
    // The scene-setters: switched on, the room goes dark round them
    // (`dim`: the room's own light while it's on; `night`: how far a flat
    // backdrop darkens behind the 3D view, 0-1). All by eye.
    campfire: {
        cat: "lights", name: "Campfire", kind: "lamp", note: "a crackling campfire", gadget: true, placed: true, slides: true,
        // A ring of stones 80 cm across round a teepee of logs (by eye);
        // wood flame about 1,900 K like a candle's. Its light by eye (some
        // dozen candles' worth reaching them a metre or two off). `fire`:
        // the burning bed's width (m), which sets how fast the flames
        // puff (puffHz below: ≈1.9 Hz).
        radius: 0.4, mass: 30, restitution: 0.02,
        art: { w: 0.84, h: 0.9, cy: 0.05 }, grab: [[0.3, 0.25]],
        lamp: { lm: 6000, color: K1900, at: [0, -0.1, 0], tint: 0, fire: 0.6, dim: 0.12, night: 0.6, sound: "fire" },
        // Flame colours: wood, then the flame-test colours of the metal
        // salts sold in coloured-fire packets (copper: green, strontium:
        // crimson, potassium: lilac). `flame`: [core, body, tip].
        shades: [{ name: "Wood", color: "#ff9a2e", light: K1900, flame: ["#fff4c2", "#ffb03a", "#e2401a"] },
            { name: "Emerald", color: "#34d399", light: "#5ef0b0", flame: ["#e9fff4", "#3ee08f", "#0f8f6a"] },
            { name: "Crimson", color: "#f43f5e", light: "#ff4d6d", flame: ["#ffe1e6", "#ff3b5c", "#a3122e"] },
            { name: "Lilac", color: "#c084fc", light: "#c48cff", flame: ["#f6ecff", "#c084fc", "#6d28d9"] }],
    },
    galaxy: {
        cat: "lights", name: "Galaxy projector", kind: "lamp", note: "a galaxy projector filling the room with stars and nebula clouds", gadget: true, placed: true,
        // A dome star projector, 14 cm across (by eye). It throws its sky
        // up and out (a wide spot, `spot` degrees) and turns once in `turn`
        // seconds (slow enough to watch a star cross, quick enough to see
        // it move); its LEDs' light by eye. `sky`: the shade's nebula
        // colours.
        radius: 0.07, mass: 0.5, restitution: 0.1,
        art: { w: 0.16, h: 0.15, cy: 0.005 },
        lamp: { lm: 300, color: "#a78bfa", at: [0, 0.03, 0], spot: 120, tint: 1, stars: true, turn: 240, dim: 0.15, night: 0.72 },
        shades: [{ name: "Nebula", color: "#7c3aed", light: "#9b7bff", sky: ["#7c3aed", "#db2777", "#2563eb"] },
            { name: "Aurora", color: "#10b981", light: "#4ff0c0", sky: ["#10b981", "#06b6d4", "#84cc16"] },
            { name: "Deep sea", color: "#2563eb", light: "#5a8cff", sky: ["#1d4ed8", "#0891b2", "#6366f1"] },
            { name: "Starlight", color: "#e2e8f0", light: "#dbe4ff", sky: [] }],
    },
    aquarium: {
        cat: "lights", name: "Aquarium", kind: "lamp", note: "an aquarium with neon tetras, guppies and a dwarf gourami", gadget: true, placed: true, slides: true,
        // A 20-gallon long tank, 30 × 12 × 12 in (76 × 30 × 30 cm, the
        // standard size), 76 kg of water and about 11 kg of glass, on a
        // 72 cm stand (by eye), lit by its hood's LEDs (by eye). Shades:
        // the light modes aquarium LEDs come with.
        radius: 0.38, mass: 105, restitution: 0.02,
        art: { w: 0.82, h: 1.08, cy: 0.16 }, grab: [[0.5, 0.4], [0.72, 0.35]],
        lamp: { lm: 400, color: K5000, at: [0, 0.6, 0], tint: 0, ripple: true, sound: "bubbler" },
        shades: [{ name: "Daylight", color: "#e0f2fe", light: K5000, water: "#7dd3fc" },
            { name: "Moonlight", color: "#93c5fd", light: "#6f9dff", water: "#3b6fd6" },
            { name: "Plant", color: "#f0abfc", light: "#ff9ff0", water: "#c084fc" },
            { name: "Sunset", color: "#fdba74", light: "#ffb36b", water: "#fb923c" }],
    },

    // ── the crew's ──────────────────────────────────────────────────────
    gerald: {
        cat: "crew", name: "Gerald plush", kind: "plush", note: "a plush toy of Gerald, the crew's megalodon", spins: true,
        radius: 0.11, mass: 0.2, restitution: 0.3, tumbles: true,
        art: { w: 0.32, h: 0.32 },
    },
    chest: {
        // Too heavy to toss over: a click sets it down beside them.
        cat: "crew", name: "Treasure chest", kind: "chest", note: "a little treasure chest", slides: true, placed: true,
        radius: 0.16, mass: 6, restitution: 0.05,
        art: { w: 0.48, h: 0.4 },
    },
    bottle: {
        cat: "crew", name: "Message in a bottle", kind: "bottle", note: "a message in a bottle",
        // An empty 0.75 l wine bottle, drawn chubby (by eye).
        radius: 0.07, mass: 0.45, restitution: 0.35, tumbles: true,
        art: { w: 0.3, h: 0.3 },
    },
    hardtack: {
        cat: "crew", name: "Ship's biscuit", kind: "food", note: "a ship's biscuit (hardtack), famously rock hard",
        // A 3 in hardtack square (by eye).
        radius: 0.04, mass: 0.03, restitution: 0.4, slides: true,
        art: { w: 0.08, h: 0.08 }, food: { bites: 3, crumbs: "#e9c46a", hard: true },
    },

    // ── made by the toys, not in the tray ───────────────────────────────
    coin: {
        cat: null, name: "Doubloon", kind: "coin", note: "a gold doubloon",
        // A Spanish 8 escudos gold coin: 36-37 mm, 27 g. Its bounce by eye.
        radius: 0.0183, mass: 0.027, restitution: 0.45, slides: true,
        art: { w: 0.037, h: 0.037 },
    },
    bubble: {
        cat: null, name: "Bubble", kind: "bubble", note: "a soap bubble",
        // Sized per bubble (by eye); the weight is the soap film's (the air
        // inside weighs what the air it displaces does), a micrometre of
        // water (by eye), most of it held up by the warm breath inside (by
        // eye: blown bubbles hang and drift). Left alone in still air a
        // bubble lasts minutes (Roux, Duchesne & Baudoin 2022): it bursts
        // on whatever it touches long before.
        radius: 0.02, film: 1e-6, restitution: 0, buoyancy: 0.85,
        life: [45, 75],
    },
};

for (const [id, def] of Object.entries(TOYS)) def.id = id;

export const trayToys = (cat) => Object.values(TOYS).filter((t) => t.cat === cat);

// The hoop the basketball brings out, mini-basketball size: the ring 2.60 m
// up on a 1.20 × 0.90 m board (the Italian federation's mini-basketball
// rules), the ring itself FIBA's: 450 mm inside, 16-20 mm thick, its inside
// edge 151 mm off the board, a 400-450 mm net. A ball dropped on the board
// comes back at least half the height (restitution 0.71), and the ring
// takes 35-50 % of a hit's energy (0.76). FIBA Basketball Equipment 2026
// §1.1-1.3.
export const HOOP = {
    rimHeight: 2.6, rimRadius: 0.225 + 0.009, rimTube: 0.009, rimOut: 0.151 + 0.225 + 0.009,
    boardW: 1.2, boardH: 0.9, boardBelowRim: 0.15, net: 0.42,
    boardE: 0.71, rimE: Math.sqrt(1 - 0.425),
};

// The goal the football brings out: futsal's, 3 m between the posts and 2 m
// to the crossbar, posts and bar 8 cm thick, shot at from futsal's penalty
// mark 6 m out (Futsal Laws of the Game, Law 1). The net's depth and give
// are by eye.
export const GOAL = {
    width: 3, height: 2, post: 0.04, depth: 0.9, spot: 6,
};

// The rugby ball's posts (World Rugby Law 1): 5.6 m apart, the crossbar's
// top 3.0 m up, the posts at least 3.4 m tall (taken at that). The rest by
// eye: posts 10 cm thick with a pad round each foot (1.2 m tall, 26 cm
// across), the kick from 5 m out off a 6 cm tee (a conversion that fits the
// room), and a ball-stop net 2 m behind, 8 m wide and 5 m up, as grounds
// have behind the posts.
export const POSTS = {
    width: 5.6, bar: 3.0, height: 3.4, post: 0.05, spot: 5, tee: 0.06,
    padH: 1.2, padR: 0.13, netBack: 2, netW: 8, netH: 5,
};

/** The light a lamp gives in shade `i`: its colour and its brightness
 *  (lumens). Most lamps' light is the bulb's own colour where it comes
 *  straight out, the shade's where it comes through it (`tint`), dimmed by
 *  what the shade holds back. */
export function lampLight(def, i = 0) {
    const L = def.lamp, s = def.shades?.[i] || null;
    const rgb = (c) => { const v = parseInt(String(c).replace("#", ""), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
    const hex = (c) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
    if (s?.light) return { color: s.light, lm: L.lm };
    const b = rgb(L.color), sh = s ? rgb(s.color) : [255, 255, 255];
    const mixed = b.map((c, k) => c * (1 - L.tint) + ((c * sh[k]) / 255) * L.tint);
    // Its colour at full strength; how much got through, as the brightness.
    const top = Math.max(...mixed, 1);
    return { color: hex(mixed.map((c) => (c * 255) / top)), lm: L.lm * (top / Math.max(...b)) };
}

/** How often a fire `D` metres across puffs (Hz): f = 1.5 / √D, measured
 *  for buoyant plumes and pool fires (Cetegen & Ahmed 1993). */
export const puffHz = (D) => 1.5 / Math.sqrt(D);

/** A companion's own taste in food: the same companion always loves (2) or
 *  likes (1) the same food, about 3 in 10 a favourite. Nothing is off the
 *  menu for good; a bad one now and then is the item's (brains.js). Hashed
 *  from who they are, so it needs no storage and holds across sessions. */
export function tasteOf(companionKey, foodId) {
    const s = `${companionKey}|${foodId}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h % 10 < 3 ? 2 : 1;
}
