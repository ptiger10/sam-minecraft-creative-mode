# ⛏️ Blocky World — Creative Mode

A tiny, kid-friendly sandbox game in the browser, inspired by Minecraft's
creative mode. Everything is blocky — the world, the trees, the animals and
you. Explore a forest or a desert, punch trees, dig up ores, craft tools and
build whatever you like. 🌳🏜️

It's a single web page built with plain HTML/CSS/JavaScript and
[Three.js](https://threejs.org/) for the 3D graphics. No build step, no
installing anything.

![Blocky World — forest](media/screenshot.png)
![Blocky World — desert](media/screenshot-desert.png)

## ▶️ How to play it

**Easiest:** double-click `index.html` and it opens in your web browser.

**Best (so saving always works):** run a tiny local web server in this folder
and open the address it gives you. Pick whichever you have:

```bash
# Python (almost always installed)
python3 -m http.server 8000
# then open http://localhost:8000 in your browser

# ...or Node.js
npx serve
```

Everything (Three.js included) is bundled in this folder, so it works
completely offline.

## 🎮 Controls

On a phone/tablet use the on-screen buttons. On a computer you can use the
buttons **or** the keyboard.

| Action | On-screen | Keyboard |
| --- | --- | --- |
| Walk forward | ⬆ | `W` / `↑` |
| Turn left | ⟲ | `A` / `←` |
| Turn right | ⟳ | `D` / `→` |
| Jump | **Jump** | `Space` |
| Look up / down | drag the screen | drag the screen |
| Place / Use | **Place** (or tap the world) | `F` |
| Punch / Mine | **Mine** (or tap the world) | `Q` |
| Eat an apple | **Eat** | `E` |
| Pick a hotbar slot | tap a slot | `1`–`9` |

A quick **tap** on the world acts at the crosshair; **dragging** looks around.
A small label by the crosshair always tells you what a tap will do to whatever
you're pointing at. Tapping a **tree, leaves or an 🍎 apple always grabs/punches
it** — even with a block in your hand — so you never "place" by accident. To
**build**, tap the ground or press **Place** (which builds anywhere).

## ✨ What's in the game

- 🌍 An open, fully blocky world you spawn into — **forest** or **desert**.
- 👤 First-person view with a blocky character (you can see the item in your hand).
- 🌳 **Punch trees** to collect wood. Apple trees dangle red apples down low —
  aim the crosshair at one and tap to pick it (even with a block in your hand).
- 🍎 **Health and food bars.** Food slowly drops over time — eat apples so you
  don't starve. If your food runs out you start losing health.
- 🪨 **Fall damage:** jumping off something too tall hurts.
- 💀 If your health runs out, you die — then you can respawn.
- 🐷 **Animals** (pigs & sheep) wander around. You *can't* hurt them.
- ⛏️ **Ores to mine:** coal, iron, gold, redstone, diamond and emerald.
  Stone and ores need a **pickaxe**.
- 🎒 An **inventory** + hotbar. Whatever you select goes into your hand.
  Hold a block and place it; hold a pickaxe and mine.
- 🛠️ **Crafting:**
  - **Stick** = 2 wood
  - **Crafting Table** = 4 wood
  - **Wooden Pickaxe** = 2 sticks + 3 wood *(needs a crafting table — place one
    and tap it to open it)*
  - (bonus) **Wood Planks** = 1 wood
- 💾 **Save your progress** to the browser's local storage with the Save button
  (it also autosaves every 30 seconds). Press **Continue** on the title screen
  to come back to your world later.

## 🗂️ How the code is laid out

```
index.html        the page + all the on-screen buttons/menus
css/style.css     the look of the buttons, bars and menus
js/data.js        constants, block/item definitions, recipes, random helpers
js/world.js       world generation, block storage, rendering, animals, aiming
js/player.js      movement, collisions, the camera, fall damage, hunger
js/game.js        ties it together: inventory, crafting, controls, saving, loop
vendor/three.min.js   the Three.js 3D library (bundled so it runs offline)
test/smoke.mjs    an automated headless browser test
```

The world is drawn efficiently with one Three.js `InstancedMesh` per block
type, and only blocks that have an exposed face are sent to the GPU. Aiming
uses a fast voxel raycast (the classic Amanatides & Woo grid traversal).

## 🧪 Running the test (for developers)

There's an automated smoke test that launches the game in a real (headless)
browser and checks that worlds generate, you can move, craft, place, mine,
eat, and save/load. It uses [Playwright](https://playwright.dev/):

```bash
# needs Playwright + a chromium browser installed
PW_ROOT="$(npm root -g)" node test/smoke.mjs
```

It prints a checklist and writes `test/screenshot.png` (forest) and
`test/screenshot-desert.png` (desert).

---

Made as a fun hobby project. Have fun building! 🧱
