// VRC Avatar Tools Syphon helper.
//
// Publishes frames written by the viewer into a shared memory file as a Syphon server.
// It runs as its own small process because IOSurfaces created inside an Electron
// (Chromium) process cannot be looked up by Syphon clients such as OBS.
//
// usage: helper <server name> <shared memory file>

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#import "SyphonServerBase.h"
#import "SyphonSubclassing.h"
#import "../src/shm.h"

@interface VAVCPUSyphonServer : SyphonServerBase
- (BOOL)publishBGRA:(const uint8_t *)data width:(size_t)width height:(size_t)height;
@end

@implementation VAVCPUSyphonServer
{
    IOSurfaceRef _surface;
}

- (BOOL)publishBGRA:(const uint8_t *)data width:(size_t)width height:(size_t)height
{
    if (width == 0 || height == 0) return NO;
    if (!_surface || IOSurfaceGetWidth(_surface) != width || IOSurfaceGetHeight(_surface) != height)
    {
        if (_surface) { CFRelease(_surface); _surface = NULL; }
        _surface = [self newSurfaceForWidth:width height:height options:nil];
        if (!_surface) return NO;
    }
    if (IOSurfaceLock(_surface, 0, NULL) != kIOReturnSuccess) return NO;
    uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(_surface);
    size_t bpr = IOSurfaceGetBytesPerRow(_surface);
    size_t rowBytes = width * 4;
    if (bpr == rowBytes) memcpy(base, data, rowBytes * height);
    else for (size_t y = 0; y < height; y++) memcpy(base + y * bpr, data + y * rowBytes, rowBytes);
    IOSurfaceUnlock(_surface, 0, NULL);
    [self publish];
    return YES;
}

- (void)stop
{
    if (_surface) { CFRelease(_surface); _surface = NULL; }
    [self destroySurface];
    [super stop];
}
@end

static volatile sig_atomic_t gQuit = 0;
static void onSignal(int sig) { (void)sig; gQuit = 1; }

int main(int argc, const char *argv[])
{
    @autoreleasepool
    {
        if (argc < 3) { fprintf(stderr, "usage: %s <name> <shm file>\n", argv[0]); return 1; }
        signal(SIGTERM, onSignal);
        signal(SIGINT, onSignal);
        signal(SIGHUP, onSignal);
        pid_t parent = getppid();

        int fd = open(argv[2], O_RDWR);
        if (fd < 0) { perror("open"); return 2; }
        void *map = mmap(NULL, VAV_SHM_TOTAL, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        close(fd);
        if (map == MAP_FAILED) { perror("mmap"); return 3; }
        VAVShmHeader *hdr = (VAVShmHeader *)map;
        uint8_t *slots = (uint8_t *)map + VAV_SHM_HEADER_SIZE;

        // Needed so the process can post / receive distributed notifications.
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

        __block VAVCPUSyphonServer *server = [[VAVCPUSyphonServer alloc] initWithName:[NSString stringWithUTF8String:argv[1]] options:nil];
        if (!server) { fprintf(stderr, "could not start Syphon server\n"); return 4; }

        dispatch_queue_t q = dispatch_queue_create("vav.syphon.poll", DISPATCH_QUEUE_SERIAL);
        dispatch_async(q, ^{
            uint64_t lastSeq = __atomic_load_n(&hdr->seq, __ATOMIC_ACQUIRE);
            int idle = 0;
            while (!gQuit)
            {
                if (getppid() != parent) break; // viewer exited
                uint64_t seq = __atomic_load_n(&hdr->seq, __ATOMIC_ACQUIRE);
                if (seq != lastSeq)
                {
                    lastSeq = seq;
                    uint32_t slot = (uint32_t)(seq & 1);
                    uint32_t w = hdr->width[slot], h = hdr->height[slot];
                    if (w > 0 && h > 0 && (uint64_t)w * h * 4 <= VAV_SHM_SLOT_SIZE)
                    {
                        @autoreleasepool { [server publishBGRA:slots + slot * VAV_SHM_SLOT_SIZE width:w height:h]; }
                    }
                    idle = 0;
                }
                if (++idle % 250 == 0) __atomic_store_n(&hdr->hasClients, server.hasClients ? 1u : 0u, __ATOMIC_RELEASE);
                usleep(1000);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                [server stop];
                server = nil;
                exit(0);
            });
        });
        __atomic_store_n(&hdr->helperReady, 1u, __ATOMIC_RELEASE);
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
