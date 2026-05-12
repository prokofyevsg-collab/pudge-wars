// Saves 4 crop variants to compare which captures the face best
const sharp = require('sharp');
const path = require('path');
const src = path.join(__dirname, '../assets/chars/Models/FBX format/Textures/texture-a.png');
const dest = path.join(__dirname, '../client/assets/chars/');

const crops = [
  { name: 'v1', left: 145, top: 128, width: 220, height: 262 },
  { name: 'v2', left: 128, top: 128, width: 256, height: 256 },
  { name: 'v3', left: 128, top: 100, width: 384, height: 384 },
  { name: 'v4', left: 0,   top: 0,   width: 512, height: 512 },
];

(async () => {
  for (const c of crops) {
    await sharp(src).extract(c).resize(120, 120).png().toFile(dest + `face-${c.name}.png`);
    console.log(`Saved face-${c.name}.png`);
  }
})();
