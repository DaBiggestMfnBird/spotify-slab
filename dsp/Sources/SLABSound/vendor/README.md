# Vendored: Signalsmith Stretch

Pitch shifting and time stretching for SLAB's portable sound engine, by Signalsmith Audio, under the
MIT license (see the LICENSE files beside each).

- `signalsmith-stretch.h`: [signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) at 88061fd
- `signalsmith-linear/stft.h`, `fft.h`: [linear](https://github.com/Signalsmith-Audio/linear) at tag 0.6.6, the version signalsmith-stretch pins

Only these headers are used: the plain C++ FFT, with no platform libraries.
