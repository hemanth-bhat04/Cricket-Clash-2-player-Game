🏏 CRICKET CLASH — LAN MULTIPLAYER
====================================

REQUIREMENTS
  - Node.js (already installed if you're reading this!)
  - Both players on the same WiFi network

HOW TO START
  1. Open Terminal / Command Prompt
  2. Navigate to this folder:
       cd path/to/cricket-lan-server1
  3. Run the server:
       node server.js
  4. You'll see a Network URL like:
       http://192.168.x.x:3000
  5. Player 1: Open that URL on your device
  6. Player 2: Scan the QR code shown on Player 1's screen,
               OR type the same URL manually

HOW TO PLAY
  - Each ball: Batter picks a shot, Bowler picks a delivery
  - If they MATCH → WICKET!
  - If they don't → Batter scores those runs
  - 5 overs (30 balls) per innings, 10 wickets max
  - Lowest scorer in innings 1 must chase the target in innings 2

SHOTS (Batter)        DELIVERIES (Bowler)
  🛡️  Defensive → 1    🎯  Yorker
  🏏  Drive     → 2    ⚡  Bouncer  
  ⚡  Cut       → 3    🌀  Spinner
  🌊  Sweep     → 4    💨  Swinger
  🌙  Lofted    → 5    📍  Full
  💥  Six!      → 6    🌙  Slower

STRATEGY: Higher run shots are riskier — the bowler can guess them!
