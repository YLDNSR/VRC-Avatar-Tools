// Shared memory layout between the viewer (writer) and the Syphon helper (reader).
// Atomic fields are accessed with __atomic builtins so the header works in C and C++.
#pragma once
#include <stdint.h>

#define VAV_SHM_HEADER_SIZE 4096u
#define VAV_SHM_MAX_W 3840u
#define VAV_SHM_MAX_H 2160u
#define VAV_SHM_SLOT_SIZE ((uint64_t)VAV_SHM_MAX_W * VAV_SHM_MAX_H * 4u)
#define VAV_SHM_TOTAL (VAV_SHM_HEADER_SIZE + 2u * VAV_SHM_SLOT_SIZE)

typedef struct
{
    uint32_t width[2];
    uint32_t height[2];
    uint64_t seq;         // incremented by the writer after a slot is complete
    uint32_t hasClients;  // written by the helper
    uint32_t helperReady; // written by the helper
} VAVShmHeader;
