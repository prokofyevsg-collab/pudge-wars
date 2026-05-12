// Extracts character face sprites from UV texture sheets
// UV layout: head section is at approx x:128, y:0, w:384, h:400 in 1024x1024
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../assets/chars/Models/FBX format/Textures');
const DEST = path.join(__dirname, '../client/assets/chars');
const SIZE = 80; // output sprite size

fs.mkdirSync(DEST, { recursive: true });

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.png'));

(async () => {
  for (const file of files) {
    const letter = file.replace('texture-', '').replace('.png', '');
    await sharp(path.join(SRC, file))
      .extract({ left: 145, top: 115, width: 200, height: 260 })
      .resize(SIZE, SIZE, { fit: 'cover' })
      .png()
      .toFile(path.join(DEST, `char-${letter}.png`));
    console.log(`Extracted: char-${letter}.png`);
  }
  console.log('Done!');
})();
