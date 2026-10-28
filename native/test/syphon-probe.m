// Small Syphon client used to verify the viewer's Syphon output.
// Lists servers, connects to the first one whose name matches argv[1],
// and prints frame size plus a few pixel samples (BGRA).
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import "SyphonServerDirectory.h"
#import "SyphonClientBase.h"
#import "SyphonSubclassing.h"

@interface ProbeClient : SyphonClientBase
@end
@implementation ProbeClient
- (IOSurfaceRef)grab { return [self newSurface]; }
- (void)invalidateFrame {}
@end

static void spin(double seconds) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *match = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"";
        SyphonServerDirectory *dir = [SyphonServerDirectory sharedDirectory];
        spin(1.5);
        NSArray *servers = dir.servers;
        printf("servers: %lu\n", (unsigned long)servers.count);
        NSDictionary *target = nil;
        for (NSDictionary *d in servers) {
            NSString *name = d[SyphonServerDescriptionNameKey];
            NSString *app = d[SyphonServerDescriptionAppNameKey];
            printf("  - name=\"%s\" app=\"%s\"\n", name.UTF8String, app.UTF8String);
            if (!target && (match.length == 0 || [name containsString:match] || [app containsString:match])) target = d;
        }
        if (!target) { printf("no matching server\n"); return 1; }
        __block int frames = 0;
        ProbeClient *client = [[ProbeClient alloc] initWithServerDescription:target options:nil newFrameHandler:^(id c) { frames++; }];
        spin(2.0);
        printf("frames received in 2s: %d\n", frames);
        IOSurfaceRef s = NULL;
        for (int i = 0; i < 40 && !s; i++) { s = [client grab]; if (!s) spin(0.05); }
        if (!s) {
            id mgr = [client valueForKey:@"_connectionManager"];
            id sid = mgr ? [mgr valueForKey:@"_surfaceID"] : nil;
            printf("no surface (surfaceID=%s)\n", sid ? [[sid description] UTF8String] : "?");
            if (sid) {
                IOSurfaceRef look = IOSurfaceLookup((IOSurfaceID)[sid unsignedIntValue]);
                printf("direct lookup: %p\n", look);
            }
            return 2;
        }
        size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s), bpr = IOSurfaceGetBytesPerRow(s);
        IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
        uint8_t *p = (uint8_t *)IOSurfaceGetBaseAddress(s);
        size_t opaque = 0, transparent = 0;
        for (size_t y = 0; y < h; y += 4) for (size_t x = 0; x < w; x += 4) {
            uint8_t a = p[y * bpr + x * 4 + 3];
            if (a > 250) opaque++; else if (a < 5) transparent++;
        }
        uint8_t *c = p + (h / 2) * bpr + (w / 2) * 4;
        printf("surface %zux%zu  center BGRA=(%d,%d,%d,%d)  opaque=%zu transparent=%zu (sampled)\n", w, h, c[0], c[1], c[2], c[3], opaque, transparent);
        if (argc > 2) {
            FILE *f = fopen(argv[2], "wb");
            if (f) {
                uint32_t hdr2[3] = {(uint32_t)w, (uint32_t)h, (uint32_t)bpr};
                fwrite(hdr2, 4, 3, f);
                fwrite(p, 1, bpr * h, f);
                fclose(f);
                printf("dumped %s\n", argv[2]);
            }
        }
        uint8_t *tl = p;
        printf("top-left BGRA=(%d,%d,%d,%d)\n", tl[0], tl[1], tl[2], tl[3]);
        IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
        CFRelease(s);
        [client stop];
    }
    return 0;
}
