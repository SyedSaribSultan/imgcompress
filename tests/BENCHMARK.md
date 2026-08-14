# Head-to-head, at matched perceptual quality

Every strategy below is searched for the **smallest file that still scores SSIMULACRA 2 >= 90** against the same normalised source — the metric the image-compression community converged on, at its published 'not noticeable in a flicker test' line — so the comparison is bytes-at-equal-quality rather than bytes alone. Fixed-quality rows are *not* searched; they show what guessing a number costs.

`SSIM p5` is reported as a second witness. Two metrics agreeing is how you know a strategy compressed better rather than gaming the number the search watched.

Reproduce: `python tests/bench_vs_alternatives.py`


## camera_12mp.jpg — 2560x1920

Source 1.9 MB; normalised reference 5.4 MB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AVIF q50 (a common default) | avif | q50 | 12.3 KB | -97% | 79.8 | 0.9521 | **no** |
| WebP q75 (a common default) | webp | q75 | 22.4 KB | -94% | 75.8 | 0.9498 | **no** |
| JPEG q75 (a common default) | jpeg | q75 | 79.4 KB | -78% | 80.1 | 0.9539 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 178.3 KB | -51% | 84.9 | 0.9588 | **no** |
| pocketsize web (documents) **←** | jpeg | measured floor | 362.4 KB | best | 90.4 | 0.9657 | yes |
| pocketsize web (web) | jpeg | measured floor | 362.4 KB | +0% | 90.4 | 0.9657 | yes |
| JPEG 4:2:0 only | jpeg | q94 | 517.4 KB | +43% | 90.5 | 0.9700 | yes |
| pocketsize desktop | jpeg | measured floor | 543.8 KB | +50% | 91.4 | 0.9700 | yes |
| mozjpeg 4:4:4 only | jpeg | q94 | 543.8 KB | +50% | 91.4 | 0.9700 | yes |
| PNG lossless + zopfli | png | lossless | 2.6 MB | +621% | 100.0 | 1.0000 | yes |

## gradient.png — 1000x600

Source 3.2 KB; normalised reference 17.9 KB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pocketsize desktop **←** | webp-lossless | measured floor | 438 B | best | 100.0 | 1.0000 | yes |
| pocketsize web (web) | webp | measured floor | 450 B | +3% | 100.0 | 1.0000 | yes |
| AVIF q50 (a common default) | avif | q50 | 1.3 KB | +197% | 85.8 | 0.9955 | **no** |
| WebP q75 (a common default) | webp | q75 | 2.5 KB | +490% | 74.7 | 0.9876 | **no** |
| PNG lossless + zopfli | png | lossless | 2.7 KB | +539% | 100.0 | 1.0000 | yes |
| pocketsize web (documents) | png | measured floor | 2.8 KB | +553% | 100.0 | 1.0000 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 6.0 KB | +1299% | 77.2 | 0.9940 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 9.6 KB | +2154% | 83.0 | 0.9958 | **no** |

## logo_alpha.png — 900x900

Source 10.0 KB; normalised reference 38.4 KB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pocketsize web (web) **←** | webp | measured floor | 2.9 KB | best | 100.0 | 1.0000 | yes |
| pocketsize desktop | webp-lossless | measured floor | 3.1 KB | +10% | 100.0 | 1.0000 | yes |
| pngquant + zopfli | png8 | 8 colours | 3.9 KB | +36% | 100.0 | 1.0000 | yes |
| PNG lossless + zopfli | png | lossless | 3.9 KB | +36% | 100.0 | 1.0000 | yes |
| pocketsize web (documents) | png | measured floor | 4.1 KB | +45% | 100.0 | 1.0000 | yes |
| AVIF q50 (a common default) | avif | q50 | 7.1 KB | +148% | 81.0 | 0.9997 | **no** |
| WebP q75 (a common default) | webp | q75 | 11.1 KB | +289% | 80.8 | 0.9962 | **no** |

## photo.png — 1280x820

Source 1.7 MB; normalised reference 2.7 MB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AVIF q50 (a common default) | avif | q50 | 11.0 KB | -97% | 70.5 | 0.9227 | **no** |
| WebP q75 (a common default) | webp | q75 | 15.9 KB | -96% | 61.8 | 0.9142 | **no** |
| JPEG q75 (a common default) | jpeg | q75 | 48.6 KB | -89% | 69.8 | 0.9269 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 82.7 KB | -81% | 74.2 | 0.9352 | **no** |
| pocketsize desktop **←** | jpeg | measured floor | 439.3 KB | best | 90.7 | 0.9662 | yes |
| mozjpeg 4:4:4 only | jpeg | q96 | 439.3 KB | +0% | 90.7 | 0.9662 | yes |
| pocketsize web (documents) | jpeg | measured floor | 450.1 KB | +2% | 91.1 | 0.9711 | yes |
| pocketsize web (web) | jpeg | measured floor | 450.1 KB | +2% | 91.1 | 0.9711 | yes |
| PNG lossless + zopfli | png | lossless | 1.5 MB | +249% | 100.0 | 1.0000 | yes |

## screenshot_retina.png — 2560x1600

Source 16.5 KB; normalised reference 121.1 KB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pocketsize web (web) **←** | webp | measured floor | 1.1 KB | best | 100.0 | 1.0000 | yes |
| pocketsize desktop | webp-lossless | measured floor | 1.1 KB | +0% | 100.0 | 1.0000 | yes |
| AVIF only | avif | q45 | 2.5 KB | +130% | 91.6 | 0.9999 | yes |
| AVIF q50 (a common default) | avif | q50 | 2.5 KB | +131% | 92.3 | 1.0000 | yes |
| pocketsize web (documents) | png | measured floor | 4.2 KB | +284% | 100.0 | 1.0000 | yes |
| pngquant + zopfli | png8 | 8 colours | 4.6 KB | +322% | 100.0 | 1.0000 | yes |
| PNG lossless + zopfli | png | lossless | 4.6 KB | +322% | 100.0 | 1.0000 | yes |
| WebP q75 (a common default) | webp | q75 | 15.1 KB | +1294% | 88.3 | 0.9758 | **no** |
| WebP only | webp | q84 | 17.6 KB | +1528% | 90.4 | 0.9916 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 94.6 KB | +8640% | 88.1 | 0.9842 | **no** |
| mozjpeg 4:4:4 only | jpeg | q82 | 97.8 KB | +8940% | 92.2 | 0.9889 | yes |
| JPEG 4:2:0 only | jpeg | q85 | 109.6 KB | +10031% | 90.3 | 0.9855 | yes |
| JPEG q85 (a common default) | jpeg | q85 | 109.6 KB | +10031% | 90.3 | 0.9855 | yes |

## ui_text.png — 1280x820

Source 29.3 KB; normalised reference 55.1 KB.

| Strategy | Format | Setting | Size | vs best | SSIMULACRA 2 | SSIM p5 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pocketsize desktop **←** | png8 | measured floor | 6.8 KB | best | 93.9 | 0.9983 | yes |
| pngquant + zopfli | png8 | 16 colours | 6.8 KB | +0% | 93.9 | 0.9983 | yes |
| AVIF q50 (a common default) | avif | q50 | 7.0 KB | +4% | 87.8 | 0.9969 | **no** |
| pocketsize web (web) | webp | measured floor | 9.3 KB | +37% | 100.0 | 1.0000 | yes |
| AVIF only | avif | q88 | 11.2 KB | +66% | 90.2 | 1.0000 | yes |
| WebP q75 (a common default) | webp | q75 | 12.2 KB | +79% | 83.1 | 0.9370 | **no** |
| PNG lossless + zopfli | png | lossless | 21.5 KB | +217% | 100.0 | 1.0000 | yes |
| pocketsize web (documents) | png | measured floor | 23.4 KB | +246% | 100.0 | 1.0000 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 31.4 KB | +363% | 78.8 | 0.9760 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 35.4 KB | +422% | 83.4 | 0.9807 | **no** |
| mozjpeg 4:4:4 only | jpeg | q92 | 48.2 KB | +612% | 91.5 | 0.9939 | yes |
| JPEG 4:2:0 only | jpeg | q98 | 60.5 KB | +792% | 90.2 | 0.9997 | yes |
