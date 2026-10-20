# GeoCrafter: a Minecraft-style block game inside real street photos

GeoCrafter is GeoGuessr meets Minecraft: a block game you play inside Google Street View and other
real 360° street photos. You stand in the photo, step from one to the next, build with blocks, dig
up the real road and blow up the real buildings.

An experimental project, made by [furk.ai](https://www.instagram.com/furk.ai/). Formerly called
**Street Craft** (StreetCraft), the name on the logo in the first videos.

**Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.** Not
affiliated with Google or GeoGuessr either.

Türkçe: [README.tr.md](README.tr.md)

## Run it

The steps are the same on Windows and macOS.

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. Get the project: `git clone https://github.com/furktunay/geocrafter.git`, or download it from
   GitHub as a ZIP and unpack it.
3. Open a terminal in the project folder (Terminal on macOS, Command Prompt or PowerShell on
   Windows) and run:

   ```bash
   npm install
   npm run dev
   ```

4. Open `http://localhost:5173` in your browser. If that port is taken, the terminal prints the
   address to use instead.

On Windows, if PowerShell refuses to run `npm`, use Command Prompt.

## Drone defence mode

Press **U** in the game (or use the *Drone defence* button on the title screen, or open the page
with `?drones`). Waves of hostile quadcopters come at you from behind buildings (you first see
them climbing over the roofline), from inside buildings (they smash out through a window), or from
the open sky. Hold **right click** to draw the bow, let go to shoot; arrows fly flat and fast in
this mode and break windows. A radar (under the minimap) shows drones in the air, call-outs give
clock positions ("Contact, 10 o'clock, high"), and a rising whine warns of ones still hiding in a
room. A drone that reaches you goes off. Windows broken in a session are put back afterwards and
are never saved. Code: `src/drones.js`.

## Counter-UAS training platform

A training layer on top of drone defence: scripted and procedurally generated scenarios, decision-tree
scoring, accounts, and an after-action-review dashboard for trainees and instructors.

```
npm install
npm run train            # builds the game and dashboard, starts the server on http://localhost:3001
```
The first start prints the **instructor registration code** (or set `CUAS_INSTRUCTOR_CODE`). Open
`/dashboard.html`: instructors create a unit (and get its join code), trainees create an account with
that code. Behind HTTPS, start the server with `SECURE_COOKIE=1`. For development run `npm run dev`
and `npm run server` in two terminals. `npm test` runs the 130+ checks.

**The drill** (in the simulator, launched from the dashboard's *Train* tab): spot a contact, aim at it
and press **T** (designate), press **1-5** to classify it (hostile attack / hostile recon / friendly /
civilian / bird), then engage with the bow or hold fire. Radar tracks give range, height, speed, size and
IFF; radar is blocked behind buildings; at night only beacon lights show.

**Scenario conditions:** day / dusk / night; radar full, degraded (short range, flickering, ghost
tracks) or jammed; IFF reliable or degraded (and spoofed by some hostiles); single drones, mixed
traffic with friendly, civilian and bird distractors, hostile recon aircraft, and swarms. Terrain is
the place you load (urban or rural): the simulator measures it and records it with the session.
Scripted scenarios S1-S8 are in `src/scenario.js`; the generator builds more from a seed, never
repeating a recent one, and the server recommends the next difficulty from the trainee's history.

**Scoring** (`src/scoring.js`, shared by game, server and dashboard): per contact, detection 30
(designated within 3 s scores fully, 15 s scores nothing) + classification 30 + engagement decision 40,
minus a penalty for engaging a friendly (60), civilian (50) or bird (10). Engaging before classifying
halves the decision score. Session score is the weighted mean (hostile attack drones count double) less
false alarms, capped below the 70 pass mark if the position is overrun. The server re-scores every
result from the raw contact records.

## Street photos

Two places in Amsterdam, **Nieuwmarkt** and **Arena Boulevard**, work straight away on free street
photos. Every other place, and adding your own, needs Google Street View with your own key.

## Getting a Google key

1. In the [Google Cloud Console](https://console.cloud.google.com/), pick or create a project with
   billing enabled.
2. Enable the **Map Tiles API** for it.
3. Create an **API key**. Restrict it to the Map Tiles API, and to the address you play from
   (`http://localhost:5173/*`).
4. In the game: **Options → Google Street View**, paste the key, save.

Good to know:

- The key stays in your browser. It is never in the repository or in a build.
- Google gives the first 100,000 Street View tiles a month for free and charges after that (check
  its current prices). The game stops at 90,000 a month unless you raise that in Options.

## Data and licences

- Amsterdam panoramas: open data of [Gemeente Amsterdam](https://api.data.amsterdam.nl/panorama/)
- Elevation: [AHN](https://www.ahn.nl) (PDOK, open data); building outlines: [3D BAG](https://3dbag.nl), CC BY 4.0
- Roads, water, land cover: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [OpenFreeMap](https://openfreemap.org)
- Tokyo buildings: [Project PLATEAU](https://www.mlit.go.jp/plateau/); elevation elsewhere: GSI Japan, Mapzen Terrarium
- Volunteer panoramas where used: [Panoramax](https://panoramax.fr) contributors, CC BY-SA 4.0
- Street View: © Google, shown through the Map Tiles API with the player's own key
- Menu typeface: [Jersey 15](https://fonts.google.com/specimen/Jersey+15), SIL Open Font License

The code is under the [MIT licence](LICENSE).
# SIH267
