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
      seagull: [
        "Did you just bonk a seagull? Mid-game?",
        "Leave the poor seagull alone!",
        "That seagull had it coming, honestly.",
        "Bonk! Nice aim, Captain. Now aim at the game.",
      ],
      bottle: [
        "A message from the Captain? Read it out!",
        "Another bottle. The Captain does love a bottle.",
        "Ooh, orders from the top. What does it say?",
      ],
      cat: [
        "Evie! Hello, gorgeous.",
        "Is the cat... helping you?",
        "Evie's on your side, apparently. Traitor.",
      ],
      kraken_tax: [
        "Did the Kraken just rob you? Ha!",
        "You had one job: hit the tentacle.",
        "The Kraken takes its cut. It always does.",
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
    "Chess": {
      check: ["Check! Mind your Captain's hat.", "Check. Your Captain looks a little exposed, Captain.", "Check! Where's your Captain going to run?"],
      checked: ["Hey! Hands off my Captain.", "Check? Rude. Accurate, but rude.", "My Captain is fine. Mostly fine."],
      took_kraken: ["Calamari tonight! Your Kraken, I'm afraid.", "I've got your Kraken. She's very slippery.", "Your Kraken's mine now. She seems happier."],
      lost_kraken: ["Not my Kraken! She had a tiara and everything!", "My Kraken! I will avenge her. Probably.", "You took my Kraken. We're not friends right now."],
      promote: ["My little crab is all grown up!", "One crab, all the way across. I'm so proud.", "Never underestimate a crab."],
      en_passant: ["En passant. Look it up. It's real, I promise.", "Sideways capture! Proper crab behaviour."],
      threat: ["I'd keep an eye on your Captain if I were you.", "Something's brewing on my side of the board.", "Ooh. I like where this is going."],
      odds: ["No Kraken for you? Brave. Very brave.", "Playing without your Kraken? I'll try not to laugh."],
      timeout: ["The fuse burnt out! Somebody panicked.", "Tick, tick, boom, Captain."],
      draw: ["A draw. Two Captains, zero winners. Very diplomatic.", "Stalemate. Our Captains are both too stubborn to lose."],
      own_blunder: ["Wait. Was that bad? That was bad.", "I meant to do that. Probably.", "Don't look at that move. Look at me instead."],
    },
    "Hold'em": {
      all_in: ["All in. Your move, Captain.", "Everything. Every last doubloon.", "I'm all in. Don't blink."],
      user_all_in: ["All in? You're either brilliant or bluffing.", "Ooh. Okay. Let me think about this.", "That's a lot of doubloons to stare at."],
      they_fold: ["Fine. Take it. I'll remember this.", "Fold. I'm saving my strength.", "You can have that one. Enjoy it."],
      user_folds: ["Thank you kindly.", "I'll take that.", "Folding already? I barely got started."],
      show_bluff: ["Oh, did you want to see? I had nothing.", "Absolutely nothing. You're welcome.", "Bluffed. Don't tell the crew."],
      caught_bluff: ["Okay, yes, I was bluffing. Was it that obvious?", "You called that? Rude.", "Fine. I had nothing. Happy?"],
      bad_beat: ["Are you serious? On the river?", "The sea giveth and the river taketh away.", "That card should be illegal."],
      suckout: ["Sometimes the river loves me.", "I'd apologise, but I'm not sorry.", "Lucky? I prefer gifted."],
      big_pot: ["Come to me, doubloons.", "Now that's a pot."],
      polly: ["That parrot is a liar.", "Polly, whose side are you on?", "Ignore the bird. The bird knows nothing."],
      hero_call: ["You called that with THAT? Respect.", "How did you know?"],
    },
    "Broadside": {
      fire: ["Fire!", "Here comes trouble!", "Duck, Captain!", "Special delivery!"],
      hit: ["Ha! Right in the timbers!", "Direct hit! Did that tickle?", "Bullseye! Sort of. Ship's-eye."],
      miss: ["The sea needed that more than you did.", "Missed. The fish send their regards.", "Okay, that one was a warning shot."],
      hurt: ["Ow! My lovely ship!", "Hey! I just had that painted!", "Okay, now it's personal."],
      kraken: ["Is that a Kraken? Why is there always a Kraken?", "Kraken! Nobody panic! Okay, panic a bit."],
    },
    // Missions aboard the Rexmaw: you captain, aim and fire; they're your
    // gunnery partner and, in the dark, your navigator, acting on your
    // orders. Off a call these are their voice for the big moments.
    // "they_lose" holds the lines for a job done (the kit's win) and
    // "they_win" for a mission lost (its loss), as the kit's game.end()
    // picks them; "user_streak" / "their_streak" stand in for those after
    // three of a kind in a row; "greet" is the kit's hello. (No "draw": a
    // mission is always won or lost.)
    "Rexmaw Raids": {
      greet: ["Guns are loaded and I'm right here. Where to, Captain?", "You aim, I'll call the shots you can't see. Deal?", "Ready when you are, Captain. Just give the word."],
      board: ["Grapples over! Boarding party, with me!", "Alongside! Over the rail, everyone!", "Boarding! Keep her steady, Captain."],
      sink: ["She's going down! Beautiful shooting, Captain.", "That's one less ship on the water.", "Down she goes. Who's next?"],
      surrender: ["White flag! She's striking her colours!", "They've given up. Bring us alongside, gently.", "She surrenders! Easiest prize all day."],
      brace: ["Brace! Brace!", "Hold on to something, here it comes!", "Brace for it, Captain!"],
      man_overboard: ["Someone's in the water! Get a line out!", "Man overboard! Slow her down, Captain!"],
      bank: ["That's in the bank. Nobody can take it now.", "Banked! Rex is counting every coin twice.", "Safe in port. Let's go and get more."],
      kraken: ["That's no reef. Kraken! Clear the rails!", "Tentacles on the deck! Shoot them off!", "Kraken! Of course it's a Kraken."],
      legendary: ["That's the big one, Captain. Make every broadside count.", "A legend, hunting us. I'm honoured. And a bit scared.", "Here she comes. Stay with me, Captain."],
      tower_down: ["Tower down! Three more to go... or fewer!", "That tower's rubble. Lovely aim.", "Got one! Line up the next tower."],
      spotted: ["Lantern's on us! They've seen us!", "We're spotted, Captain. Run or fight?", "So much for sneaking. They know we're here."],
      pickup_chest: ["A whole chest! Today's a good day.", "Treasure! Rex is going to be insufferable.", "Ooh, heavy. That one's worth the detour."],
      mission_success: ["Job done, Captain! We make a very good pair.", "That's the mission. I knew you'd pull it off.", "Done and dusted. Same time tomorrow?"],
      mission_fail: ["Not this time. We'll get it next run.", "That one got away from us. Again?", "We're all still here, Captain. That's what counts."],
      they_lose: ["Job done! What a run, Captain.", "You aimed, I called it, and it worked. Again?", "Mission complete. I'm proud of us."],
      they_win: ["Not our day. We'll be back out there soon.", "We lost this one, but not the crew. That's what matters.", "Next time we try it another way. I've got ideas."],
      user_streak: ["Three in a row, Captain! The whole coast knows our flag now.", "Another one! We're getting scarily good at this.", "That's a streak. Rex wants it painted on the hull."],
      their_streak: ["Rough few runs, Captain. We're still afloat, and still together.", "The sea's had a good week. Ours starts next run.", "Let's slow down and try it fresh. I'm still right here."],
      whacky_captain: ["Is that their captain? Honestly? Okay. Okay, sure. Get them!", "Who keeps hiring these people? Doesn't matter. Over the rail!", "I'm not even surprised any more. Swords out, everyone.", "Right. That's a weird one. We hit it anyway."],
      big_miss: ["The fish are very scared now. Mission accomplished?", "That was a warning shot. A very wet warning shot.", "We'll call that a test of the sea's reflexes. The sea passed."],
      one_volley: ["One volley! Did you see that? Tell me you saw that!", "Gone in one. I'm framing that shot.", "That's the fastest sinking I've ever seen. Do it again!"],
      silly_hit: ["Ow! Who put that there?", "That wasn't in the plan. Nothing's in the plan, but still."],
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
