# Video benchmark

Reproduce:

```bash
python tests/make_video_fixtures.py
python tests/bench_video.py
```

Every strategy that can be searched is searched for the **smallest file that still scores SSIMULACRA 2 >= 92** against the same source, so the comparison is bytes-at-equal-quality rather than bytes alone. The fixed-setting rows are *not* searched: they are what taking the internet's advice costs on content it does not happen to suit.

SSIMULACRA 2 is pooled worst-first (the low percentile, not the mean), because a per-frame metric cannot see time and an average hides exactly the moments a person notices. **XPSNR is reported as a second witness** - it comes from a different family and carries a temporal term, and two metrics agreeing is how you know a strategy compressed better rather than gamed the number the search watched.

**Read the harder clips with this in mind.** These sources are written near-lossless on purpose, so `motion` and `grain` are close to the worst case a compressor ever meets: matching a pristine master at a visual match of 92 is a far harder ask than matching footage a camera has already compressed once, which is what a person actually hands this tool. Where no strategy clears the floor, the engine says so rather than shipping a file that quietly missed it - and the row to compare against is the fixed-setting one at a similar size, not the floor.

### motion.mp4

480x270, 3.0s, 1,692,791 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 23,354 | - | 73.3 | 35.0 dB | **no** |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 24,300 | - | 83.0 | 36.8 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 30,026 | - | 84.7 | 36.8 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 32,226 | - | 79.9 | 35.9 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 40,768 | - | 78.6 | 35.7 dB | **no** |
| pocketsize, AV1 only | searched -> av1-mp4 CRF 12 | 53,962 | - | 84.9 | 37.0 dB | **no** |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 12 | 53,962 | - | 84.9 | 37.0 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 12 | 161,171 | - | 85.7 | 37.6 dB | **no** |

### screen.mp4

480x270, 3.0s, 8,786 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| pocketsize, AV1 only **<-** | searched -> av1-mp4 CRF 52 | 3,379 | 1.00x | 98.1 | 72.6 dB | yes |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 52 | 3,379 | 1.00x | 98.1 | 72.6 dB | yes |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 3,426 | 1.01x | 98.8 | 76.1 dB | yes |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 3,460 | 1.02x | 98.9 | 77.5 dB | yes |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 8,272 | 2.45x | 94.3 | 49.6 dB | yes |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 8,348 | 2.47x | 90.9 | 47.0 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 8,503 | 2.52x | 95.9 | 52.6 dB | yes |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 24 | 8,508 | 2.52x | 95.6 | 51.0 dB | yes |

### grain.mp4

480x270, 3.0s, 7,966,088 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 738,104 | - | -28.2 | 27.3 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 2,046,185 | - | 28.4 | 34.0 dB | **no** |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 2,069,861 | - | 37.9 | 35.5 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 2,080,416 | - | 28.4 | 34.2 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 2,919,518 | - | 58.1 | 38.8 dB | **no** |
| pocketsize, AV1 only | searched -> av1-mp4 CRF 12 | 4,670,321 | - | 79.1 | 44.1 dB | **no** |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 12 | 4,670,321 | - | 79.1 | 44.1 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 12 | 5,561,058 | - | 82.2 | 45.9 dB | **no** |

### still.mp4

480x270, 3.0s, 18,069 bytes as given.

| Strategy | Setting | Size | vs best | SSIMULACRA 2 | XPSNR | Clears floor |
| --- | --- | ---: | ---: | ---: | ---: | :---: |
| SVT-AV1 CRF 30 (a common AV1 default) | CRF 30 | 7,258 | 0.73x | 90.5 | 47.5 dB | **no** |
| SVT-AV1 CRF 24 (a common AV1 default, better) | CRF 24 | 8,701 | 0.87x | 91.2 | 48.4 dB | **no** |
| pocketsize, AV1 only **<-** | searched -> av1-mp4 CRF 16 | 9,952 | 1.00x | 94.8 | 62.1 dB | yes |
| **pocketsize (both, it chooses)** | searched -> av1-mp4 CRF 16 | 9,952 | 1.00x | 94.8 | 62.1 dB | yes |
| x264 CRF 28 (the usual advice, smaller) | CRF 28 | 12,154 | 1.22x | 84.8 | 45.8 dB | **no** |
| x264 CRF 22, veryfast (a HandBrake-style fast preset) | CRF 22, veryfast | 13,278 | 1.33x | 89.0 | 49.2 dB | **no** |
| x264 CRF 23 (the usual advice) | CRF 23 | 13,675 | 1.37x | 91.1 | 53.0 dB | **no** |
| pocketsize, H.264 only | searched -> h264-mp4 CRF 18 | 14,527 | 1.46x | 93.8 | 57.8 dB | yes |
