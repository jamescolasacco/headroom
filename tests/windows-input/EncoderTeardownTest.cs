using Headroom.Host.Capture;
using Headroom.Host.Video;
using Vortice.DXGI;

// A hardware encoder that works asynchronously (NVIDIA's, among others) hands over its output on its own event thread.
// Stopping one with frames still in flight could free it under that thread (the likely cause of an access violation in
// ntdll at about one session end in ten). This stops one again and again with frames in flight, so a regression is
// likelier to crash here than now and then in use, and checks that nothing comes out of an encoder once it's stopped.
// It needs an asynchronous hardware encoder; elsewhere (CI runners) it says so and skips.
internal static class EncoderTeardownTest
{
    internal static void Run()
    {
        var gpus = new List<GpuDevice>();
        try
        {
            using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
            for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
            {
                // Microsoft's own (Basic Render, WARP, virtual displays) have no hardware encoder.
                if (adapter.Description1.VendorId == 0x1414)
                {
                    adapter.Dispose();
                    continue;
                }
                try { gpus.Add(GpuDevice.Get(adapter)); }
                catch (Exception ex) { Console.WriteLine($"Encoder teardown: GPU {a} isn't usable ({ex.Message})"); }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Encoder teardown: no GPUs here ({ex.Message}), skipped");
            return;
        }
        int tested = 0;
        foreach (var gpu in gpus)
            if (StopRepeatedly(gpu)) tested++;
        if (tested == 0) Console.WriteLine("Encoder teardown: no asynchronous hardware encoder here, skipped");
    }

    /// <summary>False when <paramref name="gpu"/> has no asynchronous hardware encoder.</summary>
    private static bool StopRepeatedly(GpuDevice gpu)
    {
        const int Rounds = 40;
        int outputs = 0, late = 0;
        string name = "";
        for (int round = 0; round < Rounds; round++)
        {
            bool stopped = false;
            MfH264Encoder encoder;
            try
            {
                encoder = MfH264Encoder.Create(gpu, new EncoderOptions { Width = 1280, Height = 720, Fps = 60, BitrateKbps = 8000, Preference = "hardware" },
                    _ =>
                    {
                        Interlocked.Increment(ref outputs);
                        if (Volatile.Read(ref stopped)) Interlocked.Increment(ref late);
                    });
            }
            catch (Exception ex)
            {
                if (round > 0) throw new Exception($"Encoder teardown: no encoder on '{gpu.AdapterName}' after {round} stops of '{name}' (one not let go?): {ex.Message}", ex);
                return false;
            }
            name = encoder.Name;
            if (!encoder.IsAsync)
            {
                encoder.Dispose();
                return false;
            }
            using var converter = new VideoConverter(gpu, 1280, 720, 1280, 720, 0, false);
            var textures = new Vortice.Direct3D11.ID3D11Texture2D[4];
            for (int i = 0; i < textures.Length; i++) textures[i] = converter.CreateOutputTexture(true);
            try
            {
                // A few frames, the last ones still being encoded when it stops, as at the end of a session.
                for (int frame = 0; frame < 4 + round % 6; frame++)
                    encoder.EncodeTexture(textures[frame % textures.Length], frame * 166_667L, frame == 0, 100);
            }
            finally
            {
                encoder.Dispose();
                Volatile.Write(ref stopped, true);
                foreach (var texture in textures) texture.Dispose();
            }
        }
        Thread.Sleep(100); // time for anything still to come out of the last one
        if (late > 0) throw new Exception($"Encoder teardown: {late} frames came out of '{name}' after it was stopped");
        Console.WriteLine($"Encoder teardown: '{name}' on '{gpu.AdapterName}' stopped {Rounds} times with frames in flight ({outputs} frames out, none after a stop)");
        return true;
    }
}
