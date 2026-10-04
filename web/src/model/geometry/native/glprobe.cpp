/*
 * glprobe — generate the W1e golden vectors with the *native* code path.
 *
 * It is not part of the ported model. It exists so the camera/frustum goldens in
 * `src/model/geometry/golden/**` are produced by the same code the oracle runs:
 *   - the real `gcamera` / `gpoint` / `frustumXZ` / `gpolyobj` objects, linked out of
 *     `../polyworld/lib/libpolyworld.dylib` (the library the oracle binary links), and
 *   - the real fixed-function GL matrix stack (Apple's OpenGL.framework + GLU), via an
 *     offscreen legacy CGL context — the same implementation the native build uses.
 *
 * The native tree and `oracle/**` are read-only: this program only includes their
 * headers and links their library.
 *
 * Build/run:  src/model/geometry/native/glprobe.sh
 * Output:     one `kind key value...` line per vector, on stdout (see glprobe.sh, which
 *             wraps the output in the TypeScript module `src/model/geometry/golden/`).
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>

#include <OpenGL/OpenGL.h>
#include <OpenGL/gl.h>
#include <OpenGL/glu.h>

#include "gcamera.h"
#include "gmisc.h"
#include "gobject.h"
#include "gpoint.h"
#include "gpolygon.h"

// ---------------------------------------------------------------------------
// float32 bit-exact printing
// ---------------------------------------------------------------------------

// Progress tracing (stderr, off unless POLYWORLD_GLPROBE_TRACE=1): the native code
// underneath may call error()/assert and abort, and an abort does not flush stdout.
static bool tracing()
{
    static int on = -1;
    if (on < 0)
        on = (getenv("POLYWORLD_GLPROBE_TRACE") != NULL) ? 1 : 0;
    return on == 1;
}

static void trace(const char* what)
{
    if (tracing())
    {
        fprintf(stderr, "trace %s\n", what);
        fflush(stderr);
    }
}

static void printF32(const char* kind, const char* key, const float* v, int n)
{
    printf("%s %s", kind, key);
    for (int i = 0; i < n; i++)
    {
        // Hex bits make the golden exact; the decimal is for humans reading the file.
        unsigned int bits;
        memcpy(&bits, &v[i], sizeof(bits));
        printf(" %.9g:%08x", (double)v[i], bits);
    }
    printf("\n");
}

static void printF64(const char* kind, const char* key, const double* v, int n)
{
    printf("%s %s", kind, key);
    for (int i = 0; i < n; i++)
        printf(" %.17g", v[i]);
    printf("\n");
}

// GL's matrix storage: column-major, m[col*4+row]; glGetFloatv returns it in that order.
static void printMat4(const char* kind, const char* key, GLenum which)
{
    GLfloat m[16];
    glGetFloatv(which, m);
    printF32(kind, key, m, 16);
}

// ---------------------------------------------------------------------------
// offscreen legacy context
// ---------------------------------------------------------------------------

static CGLContextObj makeContext()
{
    CGLPixelFormatAttribute attribs[] = {
        kCGLPFAAccelerated,
        kCGLPFAClosestPolicy,
        kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_Legacy,
        kCGLPFAColorSize, (CGLPixelFormatAttribute)24,
        kCGLPFADepthSize, (CGLPixelFormatAttribute)24,
        (CGLPixelFormatAttribute)0
    };
    CGLPixelFormatObj pix = NULL;
    GLint npix = 0;
    CGLError err = CGLChoosePixelFormat(attribs, &pix, &npix);
    if (err != kCGLNoError || pix == NULL)
    {
        fprintf(stderr, "CGLChoosePixelFormat failed: %s\n", CGLErrorString(err));
        exit(2);
    }
    CGLContextObj ctx = NULL;
    err = CGLCreateContext(pix, NULL, &ctx);
    if (err != kCGLNoError || ctx == NULL)
    {
        fprintf(stderr, "CGLCreateContext failed: %s\n", CGLErrorString(err));
        exit(2);
    }
    CGLDestroyPixelFormat(pix);
    CGLSetCurrentContext(ctx);
    return ctx;
}

// ---------------------------------------------------------------------------
// the fixed scene configs
// ---------------------------------------------------------------------------

// Every constant below is either from the recorded oracle world
// (`oracle/minitest_von/run/normalized.wf`) or is an explicit test value; `glprobe.sh`
// repeats the provenance table in the generated module.
struct SceneConfig
{
    const char* name;
    float worldSize;     // globals::worldsize
    float agentFOV;      // agent::config.agentFOV (VerticalFieldOfView)
    float minFocus;      // agent::config.minFocus
    float maxFocus;      // agent::config.maxFocus
    float eyeHeight;     // agent::config.eyeHeight
    float agentHeight;   // agent::config.agentHeight
    int   retinaWidth;   // Brain::config.retinaWidth
    int   retinaHeight;  // Brain::config.retinaHeight
    float fLengthZ;      // agent::SetGeometry: Size() * sqrt(geneCache.maxSpeed)
    float agentX, agentY, agentZ;   // agent position (x, y, z)
    float agentYawAng;              // agent fAngle[0], degrees
    float focus;         // outputNerves.focus->get(), in [0,1]
    bool  enablePitch;
    float visionPitch;   // outputNerves.visionPitch->get(), in [0,1]
    bool  enableYaw;
    float visionYaw;     // outputNerves.visionYaw->get(), in [0,1]
};

static const float kMinVisionPitch = -7.5f;
static const float kMaxVisionPitch = 7.5f;
static const float kMinVisionYaw = -90.0f;
static const float kMaxVisionYaw = 90.0f;

// agent::FieldOfView() / UpdateVision() (InvertFocus False)
static float fieldOfView(const SceneConfig& s)
{
    return s.focus * (s.maxFocus - s.minFocus) + s.minFocus;
}

// agent::SetGraphics() / UpdateVision(): SetAspect(float,float) stores a float
static float aspectOf(const SceneConfig& s, float fovx)
{
    return (float)(fovx * s.retinaHeight / (s.agentFOV * s.retinaWidth));
}

// Gribb-Hartmann plane extraction from a clip matrix, in the native order
// left, right, bottom, top, near, far (inside the frustum iff a*x+b*y+c*z+d >= 0).
// Computed here from the matrices GL itself produced, as an independent reference for the
// port's own extractor. `m` and `vm` are column-major (GL); vm may be NULL (identity).
static void printPlanes(const char* key, const GLfloat* m, const GLfloat* vm)
{
    double clip[16];
    for (int col = 0; col < 4; col++)
        for (int row = 0; row < 4; row++)
        {
            double s = 0.0;
            for (int k = 0; k < 4; k++)
                s += (double)m[k * 4 + row] * (vm ? (double)vm[col * 4 + k] : (col == k ? 1.0 : 0.0));
            clip[col * 4 + row] = s;
        }

    static const char* names[6] = { "left", "right", "bottom", "top", "near", "far" };
    for (int i = 0; i < 6; i++)
    {
        int row;   // which clip row combines with row 4
        double sign;
        switch (i)
        {
            case 0: row = 0; sign = 1.0; break;   // left   = row4 + row1
            case 1: row = 0; sign = -1.0; break;  // right  = row4 - row1
            case 2: row = 1; sign = 1.0; break;   // bottom = row4 + row2
            case 3: row = 1; sign = -1.0; break;  // top    = row4 - row2
            case 4: row = 2; sign = 1.0; break;   // near   = row4 + row3
            default: row = 2; sign = -1.0; break; // far    = row4 - row3
        }
        // row(i) of a column-major GL matrix: element k of row i is clip[k*4 + i]
        double p[4];
        for (int k = 0; k < 4; k++)
            p[k] = clip[k * 4 + 3] + sign * clip[k * 4 + row];

        // normalize (a,b,c) so `d` is a signed distance
        double len = sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        if (len > 0.0)
            for (int k = 0; k < 4; k++)
                p[k] /= len;

        char sub[80];
        snprintf(sub, sizeof(sub), "%s.%s", key, names[i]);
        printF64("f64", sub, p, 4);
    }
}

static void runScene(const SceneConfig& s)
{
    char key[256];
    trace(s.name);

    // machine-readable config, regenerated into `golden/nativeCameraVectors.ts` so the test
    // drives the port from the same numbers this scene used (%.9g round-trips a float32)
    printf("scene %s worldSize=%.9g agentFOV=%.9g minFocus=%.9g maxFocus=%.9g eyeHeight=%.9g"
           " agentHeight=%.9g retinaWidth=%d retinaHeight=%d fLengthZ=%.9g"
           " agentX=%.9g agentY=%.9g agentZ=%.9g agentYaw=%.9g focus=%.9g"
           " enablePitch=%d visionPitch=%.9g enableYaw=%d visionYaw=%.9g\n",
           s.name, (double)s.worldSize, (double)s.agentFOV, (double)s.minFocus, (double)s.maxFocus,
           (double)s.eyeHeight, (double)s.agentHeight, s.retinaWidth, s.retinaHeight,
           (double)s.fLengthZ, (double)s.agentX, (double)s.agentY, (double)s.agentZ,
           (double)s.agentYawAng, (double)s.focus, (int)s.enablePitch, (double)s.visionPitch,
           (int)s.enableYaw, (double)s.visionYaw);

    // --- the agent's camera, set up exactly as agent::SetGraphics()/UpdateVision() do ---
    const float fovx = fieldOfView(s);
    trace("  ctor gcamera");
    gcamera cam;
    trace("  camera params");
    cam.SetAspect(aspectOf(s, fovx));
    cam.settranslation(0.0f, (s.eyeHeight - 0.5f) * s.agentHeight, -0.5f * s.fLengthZ);
    cam.SetNear(0.01f);
    cam.SetFar(1.5f * s.worldSize);
    cam.SetFOV(s.agentFOV);

    // the agent the camera is attached to (gpoint = a bare gobject with a pose)
    trace("  ctor gpoint");
    gpoint agent;
    agent.settranslation(s.agentX, s.agentY, s.agentZ);
    agent.setyaw(s.agentYawAng);
    cam.AttachTo(&agent);

    if (s.enablePitch)
        cam.setpitch(s.visionPitch * (kMaxVisionPitch - kMinVisionPitch) + kMinVisionPitch);
    if (s.enableYaw)
        cam.setyaw(s.visionYaw * (kMaxVisionYaw - kMinVisionYaw) + kMinVisionYaw);

    snprintf(key, sizeof(key), "%s.aspect", s.name);
    float aspect = aspectOf(s, fovx);
    printF32("f32", key, &aspect, 1);
    snprintf(key, sizeof(key), "%s.fovx", s.name);
    printF32("f32", key, &fovx, 1);
    snprintf(key, sizeof(key), "%s.fov", s.name);
    float fov = cam.GetFOV();
    printF32("f32", key, &fov, 1);

    // gcamera::Use(): projection (gluPerspective) then modelview
    trace("  cam.Use()");
    cam.Use();
    trace("  cam.Use() ok");

    snprintf(key, sizeof(key), "%s.obj->%s.projection", "gl", s.name);
    printMat4("mat4", key, GL_PROJECTION_MATRIX);
    snprintf(key, sizeof(key), "%s.obj->%s.modelview", "gl", s.name);
    GLfloat mv[16];
    glGetFloatv(GL_MODELVIEW_MATRIX, mv);
    printF32("mat4", key, mv, 16);

    // the frustum of the projection alone (eye space) and of the full transform (world
    // space), i.e. the six planes the native pipeline would clip against
    {
        GLfloat proj[16];
        glGetFloatv(GL_PROJECTION_MATRIX, proj);
        snprintf(key, sizeof(key), "%s.eyePlanes", s.name);
        printPlanes(key, proj, NULL);
        snprintf(key, sizeof(key), "%s.worldPlanes", s.name);
        printPlanes(key, proj, mv);
    }

    // the camera's own eye point in world space, i.e. the point the modelview maps to the
    // origin: what the retina is rendered from (spec §5.5 / §5.1)
    // mv = Rz(-roll)Rx(-pitch)Ry(-yaw)T(-campos)Rz(-a2)Rx(-a1)Ry(-a0)T(-agentpos)
    // Solve mv * eye = 0: invert the upper-left 3x3 against the negated translation column.
    double a[3][3], b[3];
    for (int c = 0; c < 3; c++)
    {
        for (int r = 0; r < 3; r++)
            a[r][c] = (double)mv[c * 4 + r];
        b[c] = -(double)mv[12 + c];
    }
    double det =
        a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
        a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
        a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    double inv[3][3];
    inv[0][0] = (a[1][1] * a[2][2] - a[1][2] * a[2][1]) / det;
    inv[0][1] = (a[0][2] * a[2][1] - a[0][1] * a[2][2]) / det;
    inv[0][2] = (a[0][1] * a[1][2] - a[0][2] * a[1][1]) / det;
    inv[1][0] = (a[1][2] * a[2][0] - a[1][0] * a[2][2]) / det;
    inv[1][1] = (a[0][0] * a[2][2] - a[0][2] * a[2][0]) / det;
    inv[1][2] = (a[0][2] * a[1][0] - a[0][0] * a[1][2]) / det;
    inv[2][0] = (a[1][0] * a[2][1] - a[1][1] * a[2][0]) / det;
    inv[2][1] = (a[0][1] * a[2][0] - a[0][0] * a[2][1]) / det;
    inv[2][2] = (a[0][0] * a[1][1] - a[0][1] * a[1][0]) / det;
    double eye[3];
    for (int r = 0; r < 3; r++)
        eye[r] = inv[r][0] * b[0] + inv[r][1] * b[1] + inv[r][2] * b[2];
    snprintf(key, sizeof(key), "%s.eyeWorld", s.name);
    printF64("f64", key, eye, 3);

    // --- frustumXZ, the native XZ culling frustum (agent::UpdateVision) ---
    frustumXZ fxz;
    fxz.Set(s.agentX, s.agentZ, s.agentYawAng, fovx);
    snprintf(key, sizeof(key), "%s.frustumXZ", s.name);
    float fz[4] = { fxz.x0, fxz.z0, fxz.angmin, fxz.angmax };
    printF32("f32", key, fz, 4);

    // inside/outside for a fan of probe points (XZ plane), and the radius variant
    static const float probes[][3] = {
        { 10.0f, 0.0f, 0.0f },   // in front (depends on yaw)
        { 0.0f, 0.0f, 0.0f },    // world origin
        { 25.0f, 0.0f, -25.0f }, // far corner
        { 10.0f, 0.0f, -30.0f }, // behind the agent's start
    };
    snprintf(key, sizeof(key), "%s.frustumXZ.inside", s.name);
    printf("bool %s", key);
    for (int i = 0; i < 4; i++)
    {
        float p[3] = { probes[i][0], probes[i][1], probes[i][2] };
        printf(" %d", fxz.Inside(p));
    }
    printf("\n");

    frustumXZ fxz5;
    fxz5.Set(s.agentX, s.agentZ, s.agentYawAng, fovx, 1.0f);
    snprintf(key, sizeof(key), "%s.frustumXZ.rad1", s.name);
    float fz5[4] = { fxz5.x0, fxz5.z0, fxz5.angmin, fxz5.angmax };
    printF32("f32", key, fz5, 4);
}

// A poly-object bounding box / radius, i.e. gpolyobj::setlen() + setradius()
static void runGeometryProbe()
{
    // A 1x1x1 box and an L-shaped 2-polygon soup, in the units of etc/objects/*.obj.
    static const long boxPoints = 4;
    static float box0[12] = { -0.5f, -0.5f, -0.5f,  0.5f, -0.5f, -0.5f,
                               0.5f,  0.5f,  0.5f, -0.5f,  0.5f,  0.5f };
    static float box1[12] = { -0.25f, -0.5f, 1.5f,  0.75f, -0.5f, 1.5f,
                               0.75f,  0.25f, 1.5f, -0.25f,  0.25f, 1.5f };
    // NOTE: gpolyobj owns both arrays (its destructor deletes `fPolygon[]` and each
    // `fVertices`), so both must be heap allocations — a stack opoly[] aborts in ~gpolyobj.
    opoly* polys = new opoly[2];
    polys[0].fNumPoints = boxPoints;
    polys[0].fVertices = new float[boxPoints * 3];
    memcpy(polys[0].fVertices, box0, sizeof(box0));
    polys[1].fNumPoints = boxPoints;
    polys[1].fVertices = new float[boxPoints * 3];
    memcpy(polys[1].fVertices, box1, sizeof(box1));

    gpolyobj obj(2, polys);
    float len[3] = { obj.lx(), obj.ly(), obj.lz() };
    printF32("f32", "polyobj.length", len, 3);
    printf("geom polyobj nPolys=2 points=4,4 v=");
    for (int i = 0; i < 2; i++)
    {
        for (int j = 0; j < 4 * 3; j++)
            printf("%s%.9g", j ? "," : "", (double)polys[i].fVertices[j]);
        printf("%s", i == 0 ? "|" : "\n");
    }
    float r = obj.radius();
    printF32("f32", "polyobj.radius", &r, 1);
    obj.setscale(2.0f);   // setscale() re-derives the radius
    r = obj.radius();
    printF32("f32", "polyobj.radius.scale2", &r, 1);
    obj.setradiusscale(3.0f);
    r = obj.radius();
    printF32("f32", "polyobj.radius.radiusscale3", &r, 1);
    obj.setradius(4.0f);  // fixed radius wins over everything
    obj.setscale(0.5f);
    r = obj.radius();
    printF32("f32", "polyobj.radius.fixed", &r, 1);
}

// The raw GL primitives the camera maths is built from (so a failing composite matrix
// localizes to one primitive).
static void runGlPrimitiveProbe()
{
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glTranslatef(1.5f, -2.25f, 0.125f);
    printMat4("mat4", "gl.translate", GL_MODELVIEW_MATRIX);
    printf("gltranslate 1.5 -2.25 0.125\n");

    const float angles[] = { 45.0f, 90.0f, -90.0f, 30.0f, 7.5f, 180.0f };
    static const char* axes[3] = { "y", "x", "z" };
    for (int i = 0; i < 6; i++)
    {
        char key[128];
        glLoadIdentity();
        glRotatef(angles[i], 0.0f, 1.0f, 0.0f);
        snprintf(key, sizeof(key), "gl.rotatef.y.%g", (double)angles[i]);
        printMat4("mat4", key, GL_MODELVIEW_MATRIX);
        printf("glrotatef %s %.9g\n", axes[0], (double)angles[i]);

        glLoadIdentity();
        glRotatef(angles[i], 1.0f, 0.0f, 0.0f);
        snprintf(key, sizeof(key), "gl.rotatef.x.%g", (double)angles[i]);
        printMat4("mat4", key, GL_MODELVIEW_MATRIX);
        printf("glrotatef %s %.9g\n", axes[1], (double)angles[i]);

        glLoadIdentity();
        glRotatef(angles[i], 0.0f, 0.0f, 1.0f);
        snprintf(key, sizeof(key), "gl.rotatef.z.%g", (double)angles[i]);
        printMat4("mat4", key, GL_MODELVIEW_MATRIX);
        printf("glrotatef %s %.9g\n", axes[2], (double)angles[i]);
    }

    // gluPerspective as gcamera::UsePerspective() calls it, over the aspect values the
    // agent cameras actually take (focus 20..140 => fovx/10 = 2..14)
    const float aspects[] = { 2.0f, 3.0f, 5.0f, 8.0f, 14.0f, 1.0f };
    for (int i = 0; i < 6; i++)
    {
        char key[128];
        glMatrixMode(GL_PROJECTION);
        glLoadIdentity();
        gluPerspective(10.0f, aspects[i], 0.01f, 37.5f);
        snprintf(key, sizeof(key), "gl.gluPerspective.10.%.6g.0.01.37.5", (double)aspects[i]);
        printMat4("mat4", key, GL_PROJECTION_MATRIX);
        printf("glperspective 10 %.9g 0.01 37.5\n", (double)aspects[i]);
    }

    // the world camera's defaults, for completeness (the widget camera's initial state)
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    gluPerspective(90.0f, 1.0f, (float)0.00001, 10000.0f);
    printMat4("mat4", "gl.gluPerspective.90.1.1e-05.10000", GL_PROJECTION_MATRIX);
    printf("glperspective 90 1 1e-05 10000\n");

    // the identity, as a control
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    printMat4("mat4", "gl.identity", GL_MODELVIEW_MATRIX);
}

// The object transform as the scene draws it (`gpolyobj::draw` / `agent::draw`):
// glPushMatrix(); position() -> translate() then rotate(); glScalef(s,s,s).
static void runObjectProbe()
{
    struct Pose
    {
        const char* name;
        float x, y, z;
        float yaw, pitch, roll;
        float scale;
        bool setRotation;   // gobject::SetRotation sets fRotated; a bare translation does not
    };
    static const Pose poses[] = {
        { "obj.yaw45", 1.0f, 0.5f, -2.0f, 45.0f, 0.0f, 0.0f, 1.0f, true },
        { "obj.yaw30_pitch-15_roll10", -3.25f, 0.0f, 7.5f, 30.0f, -15.0f, 10.0f, 2.0f, true },
        { "obj.unrotated", 5.0f, 2.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f, false },
        { "obj.rotated_zero_angles", 5.0f, 2.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.5f, true },
    };
    for (size_t i = 0; i < sizeof(poses) / sizeof(poses[0]); i++)
    {
        const Pose& p = poses[i];
        gpoint obj;
        obj.settranslation(p.x, p.y, p.z);
        if (p.setRotation)
            obj.SetRotation(p.yaw, p.pitch, p.roll);

        glMatrixMode(GL_MODELVIEW);
        glLoadIdentity();
        glPushMatrix();
        obj.position();
        glScalef(p.scale, p.scale, p.scale);
        printMat4("mat4", p.name, GL_MODELVIEW_MATRIX);
        glPopMatrix();
        printf("objpose %s %.9g %.9g %.9g %.9g %.9g %.9g %.9g %d\n", p.name,
               (double)p.x, (double)p.y, (double)p.z, (double)p.yaw, (double)p.pitch,
               (double)p.roll, (double)p.scale, (int)p.setRotation);
    }
}

// gcamera::Use() for non-agent cameras: the modelview composition and the
// PerspectiveSet() latch, plus the fPerspectiveFixed path (FixPerspective sets the aspect
// from a width/height pair and, if fixed, applies the projection immediately).
static void runCameraUseProbe()
{
    gcamera cam;
    cam.SetFOV(65.0f);
    cam.SetAspect(1.0f);
    cam.SetNear(0.25f);
    cam.SetFar(64.0f);
    cam.settranslation(3.0f, 4.0f, 5.0f);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    cam.Use();
    printMat4("mat4", "gcamera.use65_aspect1.modelview", GL_MODELVIEW_MATRIX);
    printMat4("mat4", "gcamera.use65_aspect1.projection", GL_PROJECTION_MATRIX);
    printf("bool gcamera.use65_aspect1.perspectiveSet %d\n", (int)cam.PerspectiveSet());
    printf("camuse gcamera.use65_aspect1 fov=65 aspect=1 near=0.25 far=64 x=3 y=4 z=5\n");

    gcamera fixed;
    fixed.SetFOV(60.0f);
    fixed.SetNear(0.5f);
    fixed.SetFar(16.0f);
    fixed.FixPerspective(true, 640.0f, 480.0f);   // aspect = 640/480, projection applied now
    {
        GLfloat proj[16];
        glMatrixMode(GL_PROJECTION);
        glGetFloatv(GL_PROJECTION_MATRIX, proj);
        printF32("mat4", "gcamera.fixPerspective.projection", proj, 16);
    }
    printf("bool gcamera.fixPerspective.perspectiveSet %d\n", (int)fixed.PerspectiveSet());
    printf("camfix gcamera.fixPerspective fov=60 near=0.5 far=16 width=640 height=480 x=-1 y=0 z=2\n");
    // Use() must not touch the projection once the perspective is fixed, and its modelview
    // must still be composed (note UsePerspective leaves the matrix mode on PROJECTION, so
    // the mode is set explicitly here, as gscene::Draw does with glPushMatrix/glPopMatrix)
    fixed.settranslation(-1.0f, 0.0f, 2.0f);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    fixed.Use();
    printMat4("mat4", "gcamera.fixPerspective.modelview", GL_MODELVIEW_MATRIX);
    {
        GLfloat proj[16];
        glMatrixMode(GL_PROJECTION);
        glGetFloatv(GL_PROJECTION_MATRIX, proj);
        printF32("mat4", "gcamera.fixPerspective.projectionAfterUse", proj, 16);
    }
}

// frustumXZ outside the agent ranges: the fmod/+-2pi normalisation and the *latent* bug in
// `Set` (`angmax -= (angmin > 0.0) ? TWOPI : -TWOPI` reads angmin after it was already
// updated, and the ternary tests the wrong band). PORT_SPEC rule 1: port it wrong the same
// way, so the behaviour is pinned here rather than "fixed".
static void runFrustumQuirkProbe()
{
    struct Case { const char* name; float x, z, ang, fov; };
    static const Case cases[] = {
        { "frustumQ.neg200_fov20", 0.0f, 0.0f, -200.0f, 20.0f },
        { "frustumQ.yaw350_fov140", 0.0f, 0.0f, 350.0f, 140.0f },
        { "frustumQ.yaw90_fov180", 0.0f, 0.0f, 90.0f, 180.0f },
        { "frustumQ.yaw45_fov360", 0.0f, 0.0f, 45.0f, 360.0f },
        { "frustumQ.yaw0_fov0", 0.0f, 0.0f, 0.0f, 0.0f },
        { "frustumQ.yaw180_fov140", 3.0f, -4.0f, 180.0f, 140.0f },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        frustumXZ f;
        f.Set(cases[i].x, cases[i].z, cases[i].ang, cases[i].fov);
        float v[4] = { f.x0, f.z0, f.angmin, f.angmax };
        printF32("f32", cases[i].name, v, 4);
        printf("fqcase %s %.9g %.9g %.9g %.9g\n", cases[i].name, (double)cases[i].x,
               (double)cases[i].z, (double)cases[i].ang, (double)cases[i].fov);

        static const float pts[][3] = {
            { 0.0f, 0.0f, 0.0f }, { 1.0f, 0.0f, 0.0f }, { 0.0f, 0.0f, 1.0f },
            { -1.0f, 0.0f, -1.0f }, { 3.0f, 0.0f, -4.0f }
        };
        printf("bool %s.inside", cases[i].name);
        for (int k = 0; k < 5; k++)
        {
            float p[3] = { pts[k][0], pts[k][1], pts[k][2] };
            printf(" %d", f.Inside(p));
        }
        printf("\n");
    }

    // the radius overload (Set with `rad`): the apex is pushed back by rad/sin(fov/2)
    static const float rads[] = { 0.5f, 1.0f, 2.5f };
    for (int i = 0; i < 3; i++)
    {
        frustumXZ f;
        f.Set(4.0f, -6.0f, 30.0f, 80.0f, rads[i]);
        float v[4] = { f.x0, f.z0, f.angmin, f.angmax };
        char key[96];
        snprintf(key, sizeof(key), "frustumQ.rad%g", (double)rads[i]);
        printF32("f32", key, v, 4);
        printf("fqrad %s 4 -6 30 80 %.9g\n", key, (double)rads[i]);
    }
}

// The scene configs. `minitest_a10_*`: the values from the recorded oracle world
// (`oracle/minitest_von/run/normalized.wf` for the world settings, `run/motion/position/
// agents/position_10.txt` for the agent's first logged position); the focus/pitch/yaw
// nerve values are explicit test values (the recorded nerve values belong to L9's lane).
static SceneConfig sceneConfigs[] = {
    // agent 10 of oracle/minitest_von, focus nerve at its minimum (fovx = 20 deg)
    { "minitest_a10_focus_min", 25.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      1.0f,  15.35f, 0.1f, -16.72f, 45.0f, 0.0f, false, 0.5f, false, 0.5f },
    // same agent, focus at mid-scale (fovx = 80 deg)
    { "minitest_a10_focus_mid", 25.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      1.0f,  15.35f, 0.1f, -16.72f, 45.0f, 0.5f, false, 0.5f, false, 0.5f },
    // same agent, focus saturated (fovx = 140 deg) and the longest possible body
    // (Size()=2, maxSpeed=1.5 -> fLengthZ = 2*sqrt(1.5) = 2.4494898)
    { "minitest_a10_focus_max", 25.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      2.4494898f, 15.35f, 0.1f, -16.72f, 45.0f, 1.0f, false, 0.5f, false, 0.5f },
    // vision pitch/yaw enabled (both off in minitest, on in other worlds): pitch raw 0.25
    // -> -3.75 deg, yaw raw 0.75 -> +45 deg; the agent is the same one, at the same place
    { "vision_pitch_yaw", 25.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      1.0f,  15.35f, 0.1f, -16.72f, 45.0f, 0.25f, true, 0.25f, true, 0.75f },
    // a yaw/fov pair whose frustum wraps past +180 deg (frustumXZ::Set's fmod branch and
    // the angmin > angmax branch of Inside), with the widest possible horizontal FOV
    { "wrap_yaw170_fov140", 25.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      1.0f,  8.0f, 0.1f, -8.0f, 170.0f, 1.0f, false, 0.5f, false, 0.5f },
    // a plain unmoved agent at the origin of a 100-unit world (units/eye height only),
    // i.e. the simplest possible POV: yaw 0, no pitch/yaw nerves
    { "world100_origin", 100.0f, 10.0f, 20.0f, 140.0f, 0.5f, 0.2f, 22, 22,
      0.5f,  0.0f, 0.1f, 0.0f, 0.0f, 0.5f, false, 0.5f, false, 0.5f },
};

int main()
{
    trace("main: start");
    CGLContextObj ctx = makeContext();
    trace("main: context");

    const GLubyte* ver = glGetString(GL_VERSION);
    const GLubyte* ren = glGetString(GL_RENDERER);
    const GLubyte* gluver = (const GLubyte*)gluGetString(GLU_VERSION);
    printf("str gl.version %s\n", ver ? (const char*)ver : "(null)");
    printf("str gl.renderer %s\n", ren ? (const char*)ren : "(null)");
    printf("str glu.version %s\n", gluver ? (const char*)gluver : "(null)");

    // The matrix the fixed-function pipeline starts from, so a golden reader can tell
    // "identity" from "GL did something odd".
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();

    runGlPrimitiveProbe();
    trace("main: primitives done");
    runObjectProbe();
    trace("main: objects done");
    runCameraUseProbe();
    trace("main: camera-use done");
    runFrustumQuirkProbe();
    trace("main: frustum quirks done");
    runGeometryProbe();
    trace("main: geometry done");
    for (size_t i = 0; i < sizeof(sceneConfigs) / sizeof(sceneConfigs[0]); i++)
        runScene(sceneConfigs[i]);
    trace("main: scenes done");

    CGLSetCurrentContext(NULL);
    CGLDestroyContext(ctx);
    return 0;
}
