# Third-party notices

## OpenScreen (ideas only, no code copied)

The camera and cursor were written for demoloom after reading OpenScreen
(https://github.com/siddharthvaddem/openscreen, archived; maintained fork
https://github.com/EtienneLescot/openscreen). Ideas taken from it:

- chasing the zoom target with a spring instead of applying an eased curve
  directly (`zoomSpring.ts`); here the moves are solved in closed form, so a
  frame is a pure function of its time
- chaining close zoom regions into one pan instead of zooming out and back in
  (`zoomRegionUtils.ts`, a gap under about 1.5 s)
- smoothing the whole cursor path offline, ahead of time, so preview and export
  match (`cursorPathSmoothing.ts`)

No source was copied. Its licence is kept here for attribution:

```
MIT License

Copyright (c) 2025 Siddharth Vaddem

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts (SIL Open Font License 1.1)

- `assets/fonts/BricolageGrotesque.ttf`: Bricolage Grotesque, Copyright 2022 The
  Bricolage Grotesque Project Authors. Licence: `assets/fonts/BricolageGrotesque-OFL.txt`
- `assets/fonts/DMSans.ttf`: DM Sans, Copyright 2014 The DM Sans Project Authors.
  Licence: `assets/fonts/DMSans-OFL.txt`

Both come unmodified from https://github.com/google/fonts.

## Music samples (CC0 1.0)

`samples/`: grand piano and vibraphone notes from VCSL, the Versilian Community
Sample Library (https://github.com/sgossner/VCSL), CC0 1.0 Universal. See
`samples/LICENSES`. Every other sound is synthesized in code.

## Runtime dependencies

- Playwright (Apache-2.0), installed from npm.
- ffmpeg, installed by you; demoloom calls it as a separate program.
- faster-whisper (MIT), optional, installed by you.
