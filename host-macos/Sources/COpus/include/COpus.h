/* libopus for HeadroomKit (vendored in ../libopus, see ../libopus/SOURCE.txt), plus fixed-argument wrappers: Swift
 * can't call the variadic opus_encoder_ctl / opus_decoder_ctl. */
#ifndef HEADROOM_COPUS_H
#define HEADROOM_COPUS_H

#include "../libopus/include/opus.h"

/* opus_encoder_ctl(st, request, value) for the OPUS_SET_*_REQUEST requests that take an opus_int32. */
int copus_encoder_set(OpusEncoder *st, int request, opus_int32 value);
/* opus_encoder_ctl(st, request, &value) for the OPUS_GET_*_REQUEST requests that return an opus_int32. */
int copus_encoder_get(OpusEncoder *st, int request, opus_int32 *value);
/* opus_decoder_ctl(st, request, &value) for the OPUS_GET_*_REQUEST requests that return an opus_int32. */
int copus_decoder_get(OpusDecoder *st, int request, opus_int32 *value);

#endif
