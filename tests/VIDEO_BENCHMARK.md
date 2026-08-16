# Video benchmark

Reproduce:

```bash
python tests/make_video_fixtures.py
python tests/bench_video.py
```

Every strategy that can be searched is searched for the **smallest file that still scores SSIMULACRA 2 >= 92** against the same source. Among the rows that clear that floor, and only among those, the comparison is bytes-at-equal-quality - which is why `vs best` is blank on every row that missed it: a smaller file at a lower score is not a better result, it is a different setting. On a clip where nothing clears the floor there is no equal-quality comparison to make, and the table says so on every row rather than implying one. The fixed-setting rows are *not* searched: they are what taking the internet's advice costs on content it does not happen to suit.

Both metrics are pooled worst-first (the low percentile, not the mean), because a per-frame metric cannot see time and an average hides exactly the moments a person notices. **XPSNR is reported as a second witness** - it comes from a different family and carries a temporal term, and two metrics agreeing is how you know a strategy compressed better rather than gamed the number the search watched.

**Read the harder clips with this in mind.** These sources are written near-lossless on purpose, so `motion` and `grain` are close to the worst case a compressor ever meets: matching a pristine master at a visual match of 92 is a far harder ask than matching footage a camera has already compressed once, which is what a person actually hands this tool. Where no strategy clears the floor, the engine says so rather than shipping a file that quietly missed it - and the row to compare against is the fixed-setting one at a similar size, not the floor.

### motion.mp4

480x270, 3.0s, 1,692,791 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 23,354 | - | 73.3 | 34.4 dB | **no** |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 24,300 | - | 83.0 | 36.3 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 30,026 | - | 84.7 | 36.3 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 32,226 | - | 79.9 | 35.2 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 40,768 | - | 78.6 | 35.1 dB | **no** |
| pocketsize, AV1 only | searched -> av1-mp4 CRF 12 | 53,962 | - | 84.9 | 36.5 dB | **no** |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 12 | 53,962 | - | 84.9 | 36.5 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 12 | 161,171 | - | 85.7 | 37.2 dB | **no** |

### screen.mp4

480x270, 3.0s, 8,786 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| pocketsize, AV1 only **<-** | searched -> av1-mp4 CRF 52 | 3,379 | 1.00x | 98.1 | 63.8 dB | yes |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 52 | 3,379 | 1.00x | 98.1 | 63.8 dB | yes |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 3,426 | 1.01x | 98.8 | 70.3 dB | yes |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 3,460 | 1.02x | 98.9 | 70.1 dB | yes |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 8,272 | 2.45x | 94.3 | 49.2 dB | yes |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 8,348 | - | 90.9 | 46.5 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 25 | 8,422 | 2.49x | 95.7 | 49.5 dB | yes |
| x264 CRF 23 (the usual advice) | CRF 23 | 8,503 | 2.52x | 95.9 | 51.8 dB | yes |

### grain.mp4

480x270, 3.0s, 7,966,088 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 738,104 | - | -28.2 | 27.1 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 2,046,185 | - | 28.4 | 33.9 dB | **no** |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 2,069,861 | - | 37.9 | 34.4 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 2,080,416 | - | 28.4 | 34.0 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 2,919,518 | - | 58.1 | 37.8 dB | **no** |
| pocketsize, AV1 only | searched -> av1-mp4 CRF 12 | 4,670,321 | - | 79.1 | 43.0 dB | **no** |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 12 | 4,670,321 | - | 79.1 | 43.0 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 12 | 5,561,058 | - | 82.2 | 45.7 dB | **no** |

### still.mp4

480x270, 3.0s, 18,069 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 7,258 | - | 90.5 | 46.9 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 8,701 | - | 91.2 | 47.8 dB | **no** |
| pocketsize, AV1 only **<-** | searched -> av1-mp4 CRF 22 | 9,422 | 1.00x | 92.5 | 48.5 dB | yes |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 22 | 9,422 | 1.00x | 92.5 | 48.5 dB | yes |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 12,154 | - | 84.8 | 44.7 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 13,278 | - | 89.0 | 48.5 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 13,675 | - | 91.1 | 51.8 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 18 | 14,527 | 1.54x | 93.8 | 56.2 dB | yes |
