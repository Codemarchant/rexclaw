// The year as roaming sees it (models/roam_gags*.js): how much of each
// kind of weather this month brings, flipped for the southern hemisphere,
// and the holidays. The app has no location, so the weather is one
// temperate place's averages, not the user's sky.

// Month by month from January: Met Éireann's 1981–2010 averages for
// Dublin Airport (opendata2.met.ie, CC BY 4.0). Mean days with each,
// except `sun` (mean hours of sunshine a day) and `wind` (mean speed, kn).
const CLIMATE = {
    rain: [12, 10, 11, 10, 11, 10, 10, 11, 10, 11, 11, 12],                   // ≥ 1.0 mm
    thunder: [0.3, 0.2, 0.3, 0.2, 0.9, 0.8, 0.8, 0.9, 0.3, 0.3, 0.2, 0.2],
    hail: [1.2, 1.5, 2, 1.9, 1.3, 0.1, 0.2, 0.1, 0.1, 0.3, 0.3, 0.7],
    gale: [2.3, 1.5, 1.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.5, 0.8, 1.3],
    fog: [3.3, 3.1, 3.6, 3.6, 3.4, 2.8, 3.3, 3.8, 4.2, 3.2, 3.1, 4.1],
    snow: [4.6, 4.2, 2.8, 1.2, 0.2, 0, 0, 0, 0, 0, 0.8, 2.9],                 // snow or sleet
    lying: [1.6, 0.6, 0.1, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.9],                    // snow lying at 09 UTC
    frost: [6.4, 6.5, 3.8, 2.4, 0.3, 0, 0, 0, 0, 0.5, 3, 6.4],               // air frost
    sun: [1.9, 2.7, 3.5, 5.3, 6.2, 5.8, 5.3, 5.1, 4.3, 3.3, 2.4, 1.7],
    wind: [12.5, 12, 11.6, 9.9, 9.2, 8.6, 8.7, 8.7, 9.2, 10.4, 11, 11.3],
};
// What no station measures, by eye: leaves coming down through autumn,
// blossom round April, fireflies on summer nights.
const SHAPES = {
    leaves: [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 1, 1, 0.3],
    blossom: [0, 0, 0.6, 1, 0.6, 0, 0, 0, 0, 0, 0, 0],
    fireflies: [0, 0, 0, 0, 0.3, 1, 1, 0.6, 0.2, 0, 0, 0],
};
// Out of season it can still happen, this much as often as at its peak
// (by eye: rare, not never).
const OFF_SEASON = 0.1;

// Time zones south of the Tropic of Capricorn, where the seasons run the
// other way (from the tz database's own coordinates, zone.tab and
// zone1970.tab, with their links). In the tropics there's no winter to
// flip, so they keep the table as it is.
const SOUTH = new Set(("Africa/Gaborone Africa/Johannesburg Africa/Maputo Africa/Maseru Africa/Mbabane "
    + "America/Argentina/Buenos_Aires America/Argentina/Catamarca America/Argentina/ComodRivadavia "
    + "America/Argentina/Cordoba America/Argentina/Jujuy America/Argentina/La_Rioja America/Argentina/Mendoza "
    + "America/Argentina/Rio_Gallegos America/Argentina/Salta America/Argentina/San_Juan America/Argentina/San_Luis "
    + "America/Argentina/Tucuman America/Argentina/Ushuaia America/Asuncion America/Buenos_Aires America/Catamarca "
    + "America/Cordoba America/Coyhaique America/Jujuy America/Mendoza America/Montevideo America/Punta_Arenas "
    + "America/Rosario America/Santiago America/Sao_Paulo Antarctica/Casey Antarctica/Davis Antarctica/DumontDUrville "
    + "Antarctica/Macquarie Antarctica/Mawson Antarctica/McMurdo Antarctica/Palmer Antarctica/Rothera "
    + "Antarctica/South_Pole Antarctica/Syowa Antarctica/Troll Antarctica/Vostok Atlantic/South_Georgia "
    + "Atlantic/Stanley Australia/ACT Australia/Adelaide Australia/Brisbane Australia/Broken_Hill Australia/Canberra "
    + "Australia/Currie Australia/Eucla Australia/Hobart Australia/LHI Australia/Lord_Howe Australia/Melbourne "
    + "Australia/NSW Australia/Perth Australia/Queensland Australia/South Australia/Sydney Australia/Tasmania "
    + "Australia/Victoria Australia/West Australia/Yancowinna Brazil/East Chile/Continental Chile/EasterIsland "
    + "Indian/Kerguelen NZ NZ-CHAT Pacific/Auckland Pacific/Chatham Pacific/Easter Pacific/Norfolk Pacific/Pitcairn")
    .split(" "));

let southern = null;

function isSouthern() {
    if (southern === null) {
        try { southern = SOUTH.has(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { southern = false; }
    }
    return southern;
}

/** This month in the table's (northern) year. */
function seasonMonth(date = new Date()) {
    return (date.getMonth() + (isSouthern() ? 6 : 0)) % 12;
}

/** How much this month has of `key` (a CLIMATE or SHAPES row), against
 *  its busiest month: 1 at the peak, never under OFF_SEASON. */
export function season(key, date = new Date()) {
    const row = CLIMATE[key] || SHAPES[key];
    if (!row) return 1;
    return Math.max(OFF_SEASON, row[seasonMonth(date)] / Math.max(...row));
}

// ── the clock and the calendar ───────────────────────────────────────────

export const hour = () => new Date().getHours();
export const night = () => hour() >= 19 || hour() < 5;
export const lateNight = () => hour() < 5;

/** Easter Sunday of `year` (the Gregorian computus, Meeus' Astronomical
 *  Algorithms ch. 8). */
function easter(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

const DAY_MS = 86400000;

/** Holy week: Palm Sunday to Easter Monday. */
export function easterTime(date = new Date()) {
    const days = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - easter(date.getFullYear())) / DAY_MS);
    return days >= -7 && days <= 1;
}

/** The week up to Halloween. */
export function halloweenTime(date = new Date()) {
    return date.getMonth() === 9 && date.getDate() >= 24;
}

/** The week before Christmas, through Boxing Day. */
export function christmasTime(date = new Date()) {
    return date.getMonth() === 11 && date.getDate() >= 18 && date.getDate() <= 26;
}

/** New Year's Eve from the evening into the small hours. */
export function newYearTime(date = new Date()) {
    return (date.getMonth() === 11 && date.getDate() === 31 && date.getHours() >= 18)
        || (date.getMonth() === 0 && date.getDate() === 1 && date.getHours() < 2);
}

/** Seconds to midnight on New Year's Eve (Infinity any other day). */
export function toNewYearS(date = new Date()) {
    if (date.getMonth() !== 11 || date.getDate() !== 31) return Infinity;
    return (new Date(date.getFullYear() + 1, 0, 1) - date) / 1000;
}
