# The Bar — The Warriors (Rockstar, PS2, 2005)

This file is the reference every critic judges against. It is derived from real
in-game frames of The Warriors' Coney Island blocks, not from adjectives.
If a claim here cannot be checked against a screenshot, it does not belong here.

Secondary plates (actual image files, for pixel A/B):
`reference/mockups/` — the approved Swerve n Serve direction sheets. Use
`alley-night.png`, `courtyard-night.png`, `intersection-routes.png` as the
closest analogues to the bar. The HUD / title / results / corona plates are the
authority for presentation and are compared directly.

---

## What the bar actually looks like

**1. Night is built from pools of light, not from darkness.**
The Warriors' night streets are high contrast. Large areas fall to near-black
(deep blue-black, not grey). All colour lives inside discrete pools of warm
light thrown by streetlamps, shop windows, and doorway fixtures. A frame that is
uniformly dim reads as *unlit*, not as *night*. A frame that is uniformly lit
reads as daytime with a blue filter. The signature is **alternation**.

Checkable: sample a horizontal line across the ground in a screenshot. It must
cross at least two distinct luminance peaks with a trough below 15% luminance
between them. A flat profile fails.

**2. The ground carries the scene.**
Asphalt and sidewalk occupy the bottom 40–55% of frame and are the surface that
receives the light pools. It reads wet — light smears vertically into it.
The ground is never a flat untextured colour.

**3. Palette, sampled.**
- Asphalt in shadow: very dark desaturated blue-black, roughly `#0d1018`–`#161a24`
- Asphalt inside a sodium pool: warm amber-grey, roughly `#4a3a28`–`#6b5237`
- Brick façade: dark warm brown-red, roughly `#3a2620`–`#5c3a2e`. Never bright red.
- Sodium streetlamp core: `#ffb257`–`#ffd08a`
- Cold ambient / sky bounce: `#1b2740`–`#2c3c5e`
- Fluorescent / doorway green: `#6f9a52`–`#9ccb6a`, used sparingly and only as a fixture
- Sky: not black — a muted purple-navy that is visibly lighter than the shadowed ground

**4. Geometry is flat; detail is painted.**
Façades are boxes. Window frames, sills, brick courses, signage, grime, and
stains are all texture, not geometry. Silhouette complexity comes from a small
number of big shapes — stoops, fire escapes, awnings, parapets — not from
tessellation. If a wall has modelled bricks, it is wrong.

**5. Streets are corridors with closed sightlines.**
You can see 40–80 m down a street before atmosphere and a cross-building close
it off. Continuous building walls frame every route. There is no open horizon at
street level. This is what lets a small map feel like a neighbourhood — and it is
the single most important structural rule for hiding a 220×180 m footprint.

Checkable: from any street-level position, no screenshot may show more than
~90 m of unobstructed depth, and the far end of every corridor must terminate in
geometry or fog, never in empty sky.

**6. Atmosphere is a haze, not a soup.**
Distance fade is present and tinted (blue-grey/purple), but a player can read
signage and doorways at 30 m and the shape of a landmark at 70 m. Fog that eats
a delivery marker at 25 m is a bug, not atmosphere.

**7. Camera.**
Third person, close, shoulder-height. The player occupies roughly 15–22% of
frame height and sits near frame centre, slightly low. FOV is moderate (~55–65°).
Ground is visible from roughly mid-frame down. The camera never shows the top of
the player's head from above except during a hard obstruction pull-in.

**8. Characters read at distance by silhouette and colour block.**
Torso colour, hat, and stance carry the read. Faces are texture. Limbs are
smooth-shaded cylinders. Nothing is faceted, cubic, or crystalline.

---

## The measurable half

Independent of taste, all of these must hold:

- **60 fps** in a desktop browser at the shipped internal resolution.
- **Draw calls** under 220 in the heaviest view; **triangles** under 180k.
- **Route mastery is real:** a run that uses the three authored shortcuts must
  beat a run that uses only the main avenue by **≥ 20%** on cash, measured with
  the same seed and the same delivery count. If shortcut knowledge does not pay,
  Gauntlet 6 has failed regardless of how the map looks.
- **One animation loop**, verified by instrumentation, across five restarts.
- **Zero console errors** across a full run and five restarts.
- **No scene-object growth** across five restarts (±2 objects tolerance).

---

## How a critic uses this file

1. Get the actual output — run the harness, open the PNGs. Never judge from code.
2. Put our screenshot beside the closest reference plate with labels stripped.
3. Answer one question: **which of these two is better?** Not a score out of ten.
4. Name the single biggest remaining gap, concretely enough to act on.
5. If ours does not win, say so plainly and send it back.

Praise is not useful. A critic that approves on the first round has failed.
