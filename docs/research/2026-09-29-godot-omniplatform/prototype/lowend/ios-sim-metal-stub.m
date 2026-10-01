// Two Metal error-domain constants that Godot 4.7.2's metal-cpp static initialiser references but the
// iOS 27 simulator SDK's Metal does not export. Linked only into the S-04 simulator build.
#import <Foundation/Foundation.h>
NSString *const MTLIOErrorDomain = @"MTLIOErrorDomain";
NSString *const MTLTensorDomain = @"MTLTensorDomain";
