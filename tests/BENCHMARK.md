# Head-to-head, at matched perceptual quality

Every strategy below is searched for the **smallest file that still scores SSIM p5 >= 0.97** against the same normalised source, so the comparison is bytes-at-equal-quality rather than bytes alone. Fixed-quality rows are *not* searched — they are what guessing a number produces, and they are included to show what that costs.

`SSIMULACRA 2` is reported as an independent witness: nothing here is optimised against it, so a row that wins on bytes while its SSIMULACRA 2 collapses was gaming the search metric rather than compressing better.

Reproduce: `python tests/bench_vs_alternatives.py`


## camera_12mp.jpg — 2560x1920

Source 1.9 MB; normalised reference 5.4 MB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AVIF q50 (a common default) | avif | q50 | 12.3 KB | +-97% | 0.9521 | 79.8 | **no** |
| WebP q75 (a common default) | webp | q75 | 22.4 KB | +-94% | 0.9498 | 75.8 | **no** |
| JPEG q75 (a common default) | jpeg | q75 | 79.4 KB | +-80% | 0.9539 | 80.1 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 178.3 KB | +-55% | 0.9588 | 84.9 | **no** |
| AVIF only **←** | avif | q88 | 397.6 KB | best | 0.9757 | 85.3 | yes |
| imgcompress web (Web target) | avif | measured floor | 517.1 KB | +30% | 0.9821 | 87.7 | yes |
| JPEG 4:2:0 only | jpeg | q94 | 517.4 KB | +30% | 0.9700 | 90.5 | yes |
| imgcompress desktop | jpeg | measured floor | 543.8 KB | +37% | 0.9700 | 91.4 | yes |
| mozjpeg 4:4:4 only | jpeg | q94 | 543.8 KB | +37% | 0.9700 | 91.4 | yes |
| WebP only | webp | q98 | 622.1 KB | +56% | 0.9788 | 87.0 | yes |
| imgcompress web (Figma target) | jpeg | measured floor | 631.3 KB | +59% | 0.9724 | 92.3 | yes |
| pngquant + zopfli | png8 | 192 colours | 1.4 MB | +270% | 0.9757 | 87.4 | yes |
| PNG lossless + zopfli | png | lossless | 2.6 MB | +558% | 1.0000 | 100.0 | yes |

## gradient.png — 1000x600

Source 3.2 KB; normalised reference 17.9 KB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| imgcompress desktop **←** | webp-lossless | measured floor | 438 B | best | 1.0000 | 100.0 | yes |
| imgcompress web (Web target) | avif | measured floor | 598 B | +37% | 0.9925 | 63.6 | yes |
| AVIF only | avif | q30 | 790 B | +80% | 0.9949 | 79.6 | yes |
| AVIF q50 (a common default) | avif | q50 | 1.3 KB | +197% | 0.9955 | 85.8 | yes |
| WebP only | webp | q40 | 2.0 KB | +360% | 0.9873 | 72.6 | yes |
| WebP q75 (a common default) | webp | q75 | 2.5 KB | +490% | 0.9876 | 74.7 | yes |
| PNG lossless + zopfli | png | lossless | 2.7 KB | +539% | 1.0000 | 100.0 | yes |
| JPEG 4:2:0 only | jpeg | q40 | 4.4 KB | +940% | 0.9750 | 55.6 | yes |
| mozjpeg 4:4:4 only | jpeg | q40 | 4.5 KB | +960% | 0.9750 | 57.1 | yes |
| imgcompress web (Figma target) | jpeg | measured floor | 4.8 KB | +1015% | 0.9852 | 67.5 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 6.0 KB | +1299% | 0.9940 | 77.2 | yes |
| JPEG q85 (a common default) | jpeg | q85 | 9.6 KB | +2154% | 0.9958 | 83.0 | yes |

## logo_alpha.png — 900x900

Source 10.0 KB; normalised reference 38.4 KB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| imgcompress desktop **←** | webp-lossless | measured floor | 3.1 KB | best | 1.0000 | 100.0 | yes |
| pngquant + zopfli | png8 | 8 colours | 3.9 KB | +23% | 1.0000 | 100.0 | yes |
| PNG lossless + zopfli | png | lossless | 3.9 KB | +23% | 1.0000 | 100.0 | yes |
| imgcompress web (Figma target) | png | measured floor | 4.3 KB | +37% | 1.0000 | 100.0 | yes |
| imgcompress web (Web target) | png | measured floor | 4.3 KB | +37% | 1.0000 | 100.0 | yes |
| AVIF only | avif | q30 | 6.1 KB | +94% | 0.9982 | 79.2 | yes |
| AVIF q50 (a common default) | avif | q50 | 7.1 KB | +126% | 0.9997 | 81.0 | yes |
| WebP only | webp | q40 | 9.1 KB | +191% | 0.9943 | 74.1 | yes |
| WebP q75 (a common default) | webp | q75 | 11.1 KB | +254% | 0.9962 | 80.8 | yes |

## photo.png — 1280x820

Source 1.7 MB; normalised reference 2.7 MB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AVIF q50 (a common default) | avif | q50 | 11.0 KB | +-94% | 0.9227 | 70.5 | **no** |
| WebP q75 (a common default) | webp | q75 | 15.9 KB | +-91% | 0.9142 | 61.8 | **no** |
| JPEG q75 (a common default) | jpeg | q75 | 48.6 KB | +-73% | 0.9269 | 69.8 | **no** |
| JPEG q85 (a common default) | jpeg | q85 | 82.7 KB | +-54% | 0.9352 | 74.2 | **no** |
| AVIF only **←** | avif | q88 | 178.6 KB | best | 0.9713 | 77.7 | yes |
| WebP only | webp | q98 | 292.1 KB | +64% | 0.9784 | 79.2 | yes |
| JPEG 4:2:0 only | jpeg | q97 | 328.5 KB | +84% | 0.9757 | 79.7 | yes |
| imgcompress desktop | jpeg | measured floor | 439.3 KB | +146% | 0.9662 | 90.7 | **no** |
| mozjpeg 4:4:4 only | jpeg | q97 | 586.7 KB | +229% | 0.9757 | 92.0 | yes |
| imgcompress web (Figma target) | png | measured floor | 1.5 MB | +755% | 1.0000 | 100.0 | yes |
| imgcompress web (Web target) | png | measured floor | 1.5 MB | +755% | 1.0000 | 100.0 | yes |
| PNG lossless + zopfli | png | lossless | 1.5 MB | +757% | 1.0000 | 100.0 | yes |

## screenshot_retina.png — 2560x1600

Source 16.5 KB; normalised reference 121.1 KB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| imgcompress desktop **←** | webp-lossless | measured floor | 1.1 KB | best | 1.0000 | 100.0 | yes |
| imgcompress web (Web target) | avif | measured floor | 2.2 KB | +106% | 0.9999 | 89.0 | yes |
| AVIF only | avif | q30 | 2.4 KB | +118% | 0.9920 | 86.6 | yes |
| AVIF q50 (a common default) | avif | q50 | 2.5 KB | +131% | 1.0000 | 92.3 | yes |
| pngquant + zopfli | png8 | 8 colours | 4.6 KB | +322% | 1.0000 | 100.0 | yes |
| PNG lossless + zopfli | png | lossless | 4.6 KB | +322% | 1.0000 | 100.0 | yes |
| imgcompress web (Figma target) | png | measured floor | 5.0 KB | +358% | 1.0000 | 100.0 | yes |
| WebP only | webp | q70 | 14.7 KB | +1259% | 0.9762 | 86.3 | yes |
| WebP q75 (a common default) | webp | q75 | 15.1 KB | +1294% | 0.9758 | 88.3 | yes |
| mozjpeg 4:4:4 only | jpeg | q50 | 70.0 KB | +6370% | 0.9710 | 80.2 | yes |
| JPEG 4:2:0 only | jpeg | q50 | 76.3 KB | +6949% | 0.9710 | 78.5 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 94.6 KB | +8640% | 0.9842 | 88.1 | yes |
| JPEG q85 (a common default) | jpeg | q85 | 109.6 KB | +10031% | 0.9855 | 90.3 | yes |

## ui_text.png — 1280x820

Source 29.3 KB; normalised reference 55.1 KB.

| Strategy | Format | Setting | Size | vs best | SSIM p5 | SSIMULACRA 2 | Clears floor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AVIF only **←** | avif | q38 | 6.3 KB | best | 0.9899 | 84.3 | yes |
| pngquant + zopfli | png8 | 8 colours | 6.4 KB | +2% | 0.9794 | 83.5 | yes |
| imgcompress web (Web target) | avif | measured floor | 6.6 KB | +5% | 0.9990 | 88.2 | yes |
| imgcompress desktop | png8 | measured floor | 6.8 KB | +8% | 0.9983 | 93.9 | yes |
| AVIF q50 (a common default) | avif | q50 | 7.0 KB | +12% | 0.9969 | 87.8 | yes |
| imgcompress web (Figma target) | png | measured floor | 11.7 KB | +88% | 0.9802 | 49.3 | yes |
| WebP q75 (a common default) | webp | q75 | 12.2 KB | +94% | 0.9370 | 83.1 | **no** |
| WebP only | webp | q84 | 14.7 KB | +135% | 0.9832 | 85.7 | yes |
| PNG lossless + zopfli | png | lossless | 21.5 KB | +243% | 1.0000 | 100.0 | yes |
| mozjpeg 4:4:4 only | jpeg | q74 | 30.9 KB | +393% | 0.9779 | 80.9 | yes |
| JPEG 4:2:0 only | jpeg | q74 | 31.2 KB | +399% | 0.9762 | 78.7 | yes |
| JPEG q75 (a common default) | jpeg | q75 | 31.4 KB | +401% | 0.9760 | 78.8 | yes |
| JPEG q85 (a common default) | jpeg | q85 | 35.4 KB | +465% | 0.9807 | 83.4 | yes |
