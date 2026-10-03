/*
 * Rexclaw mini-games: the companion's reaction lines. Every companion says
 * them in their own voice (recorded once from the library, then kept: see
 * server/game_voice.py) and they pop up in the game's speech bubble. Only
 * when the two of you aren't on a call: on a call they react live.
 *
 * Written for anyone in the crew to say: first person, short, played for a
 * smile. Events are named from the companion's side ("they_win" = the
 * companion won). Changing a line just means it's recorded afresh.
 * (The crew's own cameos, Rex and the rest, are crew/lines.json.)
 */
(function () {
  "use strict";
  const LINES = {
    common: {
      greet: [
        "Right. Cards on the table, Captain. Let's see what you've got.",
        "Oh, we're doing this? We're doing this.",
        "Pull up a barrel. I'll go easy on you. Probably.",
        "Fair warning: I've been practising below deck.",
        "Loser swabs the deck. I'm just saying, I've already got my feet up.",
        "Ready when you are. Actually, I was born ready.",
        "Let's make this interesting. Winner gets bragging rights for a week.",
        "I hope you stretched. This is going to be a workout for your pride.",
      ],
      they_win: [
        "And that's how it's done on the Rexmaw.",
        "Ha! Write that one in the ship's log. In ink.",
        "Victory! I'd like it noted that I was gracious about it.",
        "Don't worry, losing to me builds character.",
        "Ooh, that felt good. Again?",
        "I'd say better luck next time, but I'll be winning that one too.",
        "Somebody play a fanfare. For me. Right now.",
        "That's mine. Frame it. Hang it in the galley.",
        "Was that too fast? I can slow down. I won't, but I can.",
        "Champion of the high seas, reporting for duty.",
      ],
      they_lose: [
        "Okay. Okay. You got me. Enjoy it while it lasts.",
        "I demand a rematch. Immediately.",
        "That was luck. Pure, salty luck.",
        "Fine. Well played. I hate it.",
        "I'm going to stare at the sea and think about what happened.",
        "Nope. Didn't count. The ship rocked.",
        "You win this round. This round.",
        "I let you win. Obviously. That's my story and I'm sticking to it.",
        "Ugh. Fine. Bow, then. You've earned one bow.",
        "I'm not sulking. This is just my thinking face.",
      ],
      draw: [
        "A draw? Nobody walks the plank today, then.",
        "Even stevens. That's almost worse.",
        "Stalemate. We're too evenly matched. It's a problem.",
        "A tie. We'll settle this properly next time.",
      ],
      user_streak: [
        "That's three in a row. Are you cheating? You're cheating.",
        "You're on fire. Someone fetch a bucket.",
        "Another one? Who taught you this?",
        "Okay, I'm officially worried now.",
        "Is this a streak? This feels like a streak. I don't like it.",
      ],
      their_streak: [
        "That's a streak, Captain. Might want to rethink your strategy.",
        "Is it me, or am I getting really good at this?",
        "Should I go easy on you? Just say the word. I won't, but say it.",
      ],
      close_call: [
        "Ooh, that was close. My heart's pounding.",
        "Careful now. One wrong move.",
        "This is getting tense. I love it.",
      ],
      taunt: [
        "Take your time. I'll just be here. Winning.",
        "Thinking hard, are we?",
        "Any day now, Captain.",
        "I can hear the cogs turning from here.",
      ],
    },
    "Connect Four": {
      block: ["Nope. Saw that coming a mile off.", "Blocked! Not today, Captain.", "Nice try. I'm watching that column.", "Denied. Politely, but denied."],
      threat: ["Ooh, I've got something brewing over here.", "Better keep an eye on my side of the board.", "I wouldn't ignore that column if I were you."],
      timeout: ["Too slow! The clock waits for no one.", "Tick tock, Captain. Tick. Tock."],
    },
    "Tic-Tac-Toe": {
      block: ["Ah ah ah. Blocked.", "Not on my watch.", "Nice idea. Wrong game."],
      mutiny: ["Mutiny rules! Three in a row and you're overboard.", "Careful. In these waters, winning is losing.", "Mutiny mode. Everything you know is wrong."],
    },
    "Rock Paper Scissors": {
      round_win: ["Read you like a sea chart.", "Predictable! I love it.", "Called it.", "You always do that, you know."],
      round_lose: ["How did you know?", "Lucky guess.", "You can't see my hand, can you? Can you?", "Hmm. You're harder to read than I thought."],
      tie: ["Great minds.", "Stop copying me!", "Again! Again!"],
    },
    "Blackjack": {
      bust: ["Bust. Well, that's the sea for you.", "Too many! Way too many.", "I flew too close to twenty-one.", "Okay, that card was rude."],
      blackjack: ["Blackjack! Somebody ring the bell!", "Twenty-one, first try. Don't hate me.", "Look at that. Natural talent."],
      dealer_bust: ["Dealer busts! Drinks are on the house!", "The house goes down! We ride!", "Ha! The house blinked first."],
      user_bust: ["Ooh. Over. Sorry, Captain.", "That's a lot of card for one hand.", "Twenty-two is not twenty-one. I checked."],
    },
    "Liar's Dice": {
      caught_you: ["Liar! I knew it. I could hear it in your dice.", "Caught you. Nobody bluffs a bluffer.", "Ha! Your poker face needs work.", "You blinked. You definitely blinked."],
      caught_me: ["Okay, so I was bluffing. A little. A lot.", "You saw right through me. Rude.", "Fine! Yes! I lied! It's a dice game!", "In my defence, it was a very good lie."],
      bad_call: ["I called that wrong, didn't I.", "Huh. You were telling the truth. That's unsettling.", "Honesty? From you? I wasn't ready."],
    },
    "Crazy Eights": {
      wild: ["Wild eight! New suit, new rules.", "Surprise! Eights are wild and so am I.", "Release the Kraken!"],
      draw_two: ["Draw two, Captain. Nothing personal.", "Oops. Two more for you.", "A little present. Two of them, actually."],
      last_card: ["One card left. Just saying.", "Down to my last card. Sweat a little.", "Last card! Start panicking."],
    },
    "Walk the Plank": {
      plank_close: ["One more wrong and it's a long walk off a short plank.", "I can see the sharks from here. Think carefully.", "The sharks are getting excited."],
      splash: ["Splash! The sharks say thanks.", "Overboard! I'll throw you a line. Eventually.", "Swim! Swim!"],
      solved: ["You got it! I'm impressed. Don't tell anyone.", "Rescued from the plank. Well done.", "How did you get that? I picked a hard one!"],
    },
    "Broadside": {
      fire: ["Fire!", "Here comes trouble!", "Duck, Captain!", "Special delivery!"],
      hit: ["Ha! Right in the timbers!", "Direct hit! Did that tickle?", "Bullseye! Sort of. Ship's-eye."],
      miss: ["The sea needed that more than you did.", "Missed. The fish send their regards.", "Okay, that one was a warning shot."],
      hurt: ["Ow! My lovely ship!", "Hey! I just had that painted!", "Okay, now it's personal."],
      kraken: ["Is that a Kraken? Why is there always a Kraken?", "Kraken! Nobody panic! Okay, panic a bit."],
    },
  };

  /** A line for `event` in `game` (falling back to the common ones), not
   *  the one said last time. */
  const last = {};
  function pickLine(game, event) {
    const list = LINES[game]?.[event] || LINES.common[event];
    if (!list?.length) return null;
    let line;
    do { line = list[(Math.random() * list.length) | 0]; } while (list.length > 1 && line === last[event]);
    last[event] = line;
    return line;
  }

  /** Every line, for recording a companion's set in one go. */
  function allLines() {
    return [...new Set(Object.values(LINES).flatMap((events) => Object.values(events).flat()))];
  }

  window.RexGame = Object.assign(window.RexGame || {}, { LINES, pickLine, allLines });
})();
