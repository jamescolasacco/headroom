using System.Runtime.InteropServices;

namespace Headroom.Host.Video;

/// <summary>
/// Minimal ICodecAPI wrapper (Vortice doesn't ship one). Calls the vtable directly:
/// IUnknown(0-2), IsSupported(3), IsModifiable(4), GetParameterRange(5), GetParameterValues(6),
/// GetDefaultValue(7), GetValue(8), SetValue(9), ...
/// </summary>
public sealed unsafe class CodecApi : IDisposable
{
    public static readonly Guid IID = new("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");

    public static readonly Guid AVLowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    public static readonly Guid AVEncCommonRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    public static readonly Guid AVEncCommonMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    public static readonly Guid AVEncCommonMaxBitRate = new("9651eae4-39b9-4ebf-85ef-d7f444ec7465");
    public static readonly Guid AVEncCommonBufferSize = new("0db96574-b6a4-4c8b-8106-3773de0310cd");
    public static readonly Guid AVEncCommonQuality = new("fcbf57a3-7ea5-4b0c-9644-69b40c39c391");
    public static readonly Guid AVEncCommonQualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f");
    public static readonly Guid AVEncMPVGOPSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    public static readonly Guid AVEncMPVDefaultBPictureCount = new("8d390aac-dc5c-4200-b57f-814d04babab2");
    public static readonly Guid AVEncVideoForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");
    public static readonly Guid AVEncH264CABACEnable = new("ee6cad62-d305-4248-a50e-e1b255f7caf8");
    public static readonly Guid AVEncVideoEncodeQP = new("2cb5696b-23fb-4ce1-a0f9-ef5b90fd55ca");
    public static readonly Guid AVEncVideoMinQP = new("0ee22c6a-a37c-4568-b5f1-9d4c2b3ab886");
    public static readonly Guid AVEncVideoMaxQP = new("3daf6f66-a6a7-45e0-a8e5-f2743f46a3a2");
    public static readonly Guid AVEncNumWorkerThreads = new("b0c8bf60-16f7-4951-a30b-1db1609293d6");
    public static readonly Guid AVEncVideoContentType = new("66117aca-eb77-459d-930c-a48d9d0683fc");
    public static readonly Guid AVEncAdaptiveMode = new("4419b185-da1f-4f53-bc76-097d0c1efb1e");
    public static readonly Guid AVEncVideoMaxNumRefFrame = new("964829ed-94f9-43b4-b74d-ef40944b69a0");
    public static readonly Guid AVEncMPVProfile = new("dabb534a-1d99-4284-975a-d90e2239baa1");

    public const uint RateControlCbr = 0;
    public const uint RateControlPeakConstrainedVbr = 1;
    public const uint RateControlUnconstrainedVbr = 2;
    public const uint RateControlQuality = 3;
    public const uint RateControlLowDelayVbr = 4;

    private const ushort VT_BOOL = 11;
    private const ushort VT_UI4 = 19;
    private const ushort VT_UI8 = 21;

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct Variant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public uint ui4;
        [FieldOffset(8)] public ulong ui8;
        [FieldOffset(8)] public short boolVal;
    }

    private nint _ptr;

    private CodecApi(nint ptr) => _ptr = ptr;

    public static CodecApi? From(nint unknown)
    {
        var iid = IID;
        if (Marshal.QueryInterface(unknown, in iid, out var p) != 0 || p == 0) return null;
        return new CodecApi(p);
    }

    private delegate* unmanaged[Stdcall]<nint, Guid*, int> IsSupportedFn => (delegate* unmanaged[Stdcall]<nint, Guid*, int>)(*(nint**)_ptr)[3];
    private delegate* unmanaged[Stdcall]<nint, Guid*, Variant*, int> GetValueFn => (delegate* unmanaged[Stdcall]<nint, Guid*, Variant*, int>)(*(nint**)_ptr)[8];
    private delegate* unmanaged[Stdcall]<nint, Guid*, Variant*, int> SetValueFn => (delegate* unmanaged[Stdcall]<nint, Guid*, Variant*, int>)(*(nint**)_ptr)[9];

    public bool IsSupported(Guid api)
    {
        if (_ptr == 0) return false;
        return IsSupportedFn(_ptr, &api) == 0;
    }

    public int SetUInt32(Guid api, uint value)
    {
        var v = new Variant { vt = VT_UI4, ui4 = value };
        return SetValueFn(_ptr, &api, &v);
    }

    public int SetUInt64(Guid api, ulong value)
    {
        var v = new Variant { vt = VT_UI8, ui8 = value };
        return SetValueFn(_ptr, &api, &v);
    }

    public int SetBool(Guid api, bool value)
    {
        var v = new Variant { vt = VT_BOOL, boolVal = value ? (short)-1 : (short)0 };
        return SetValueFn(_ptr, &api, &v);
    }

    public uint? GetUInt32(Guid api)
    {
        var v = new Variant();
        if (GetValueFn(_ptr, &api, &v) != 0) return null;
        return v.vt switch { VT_UI4 => v.ui4, VT_UI8 => (uint)v.ui8, VT_BOOL => v.boolVal != 0 ? 1u : 0u, _ => null };
    }

    public void Dispose()
    {
        if (_ptr != 0) Marshal.Release(_ptr);
        _ptr = 0;
    }
}
