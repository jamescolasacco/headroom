using Headroom.Host.Capture;
using Headroom.Host.Util;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice;
using Vortice.Mathematics;

namespace Headroom.Host.Video;

/// <summary>
/// GPU BGRA -> NV12 conversion (+ scaling and rotation) with the fixed-function D3D11 video processor.
/// Output is BT.709 limited range, matching the VUI the encoder writes, so browsers decode exact colors.
/// </summary>
public sealed class VideoConverter : IDisposable
{
    private readonly GpuDevice _gpu;
    private readonly ID3D11VideoProcessorEnumerator _enumerator;
    private readonly ID3D11VideoProcessor _processor;
    private readonly Dictionary<nint, ID3D11VideoProcessorInputView> _inputViews = new();
    private readonly Dictionary<nint, ID3D11VideoProcessorOutputView> _outputViews = new();

    public int InputWidth { get; }
    public int InputHeight { get; }
    public int OutputWidth { get; }
    public int OutputHeight { get; }

    public VideoConverter(GpuDevice gpu, int inputWidth, int inputHeight, int outputWidth, int outputHeight, int rotation, bool fullRange)
    {
        _gpu = gpu;
        InputWidth = inputWidth;
        InputHeight = inputHeight;
        OutputWidth = outputWidth;
        OutputHeight = outputHeight;

        var content = new VideoProcessorContentDescription
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputFrameRate = new Rational(60, 1),
            InputWidth = (uint)inputWidth,
            InputHeight = (uint)inputHeight,
            OutputFrameRate = new Rational(60, 1),
            OutputWidth = (uint)outputWidth,
            OutputHeight = (uint)outputHeight,
            Usage = VideoUsage.OptimalQuality,
        };
        gpu.Lock();
        try
        {
            _enumerator = gpu.VideoDevice.CreateVideoProcessorEnumerator(content);
            _processor = gpu.VideoDevice.CreateVideoProcessor(_enumerator, 0);

            var vc = gpu.VideoContext;
            using var vc1 = vc.QueryInterfaceOrNull<ID3D11VideoContext1>();
            if (vc1 != null)
            {
                vc1.VideoProcessorSetStreamColorSpace1(_processor, 0, ColorSpaceType.RgbFullG22NoneP709);
                vc1.VideoProcessorSetOutputColorSpace1(_processor, fullRange ? ColorSpaceType.YcbcrFullG22LeftP709 : ColorSpaceType.YcbcrStudioG22LeftP709);
            }
            else
            {
                vc.VideoProcessorSetStreamColorSpace(_processor, 0, new VideoProcessorColorSpace { Usage = 0, RGB_Range = 0, YCbCr_Matrix = 1, Nominal_Range = 2 });
                vc.VideoProcessorSetOutputColorSpace(_processor, new VideoProcessorColorSpace { Usage = 0, RGB_Range = 0, YCbCr_Matrix = 1, Nominal_Range = fullRange ? 2u : 1u });
            }
            vc.VideoProcessorSetStreamFrameFormat(_processor, 0, VideoFrameFormat.Progressive);
            // No driver "enhancements" (denoise, edge enhancement, auto contrast) — they smear text.
            vc.VideoProcessorSetStreamAutoProcessingMode(_processor, 0, false);
            vc.VideoProcessorSetStreamSourceRect(_processor, 0, true, new RawRect(0, 0, inputWidth, inputHeight));
            vc.VideoProcessorSetStreamDestRect(_processor, 0, true, new RawRect(0, 0, outputWidth, outputHeight));
            vc.VideoProcessorSetOutputTargetRect(_processor, true, new RawRect(0, 0, outputWidth, outputHeight));
            if (rotation != 0)
            {
                // Duplication hands us the surface in scan-out orientation; rotate it back to desktop orientation.
                var rot = rotation switch
                {
                    90 => VideoProcessorRotation.Rotation90,
                    180 => VideoProcessorRotation.Rotation180,
                    270 => VideoProcessorRotation.Rotation270,
                    _ => VideoProcessorRotation.Identity,
                };
                vc.VideoProcessorSetStreamRotation(_processor, 0, true, rot);
            }
        }
        finally { gpu.Unlock(); }
        Log.Debug("convert", $"video processor {inputWidth}x{inputHeight} -> {outputWidth}x{outputHeight} NV12 rot={rotation} fullRange={fullRange}");
    }

    public ID3D11Texture2D CreateOutputTexture(bool forEncoder)
    {
        _gpu.Lock();
        try
        {
            return _gpu.Device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)OutputWidth,
                Height = (uint)OutputHeight,
                MipLevels = 1,
                ArraySize = 1,
                Format = Format.NV12,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default,
                BindFlags = BindFlags.RenderTarget | (forEncoder ? BindFlags.ShaderResource : BindFlags.None),
                CPUAccessFlags = CpuAccessFlags.None,
                MiscFlags = ResourceOptionFlags.None,
            });
        }
        finally { _gpu.Unlock(); }
    }

    public void Convert(ID3D11Texture2D input, ID3D11Texture2D output)
    {
        _gpu.Lock();
        try
        {
            if (!_inputViews.TryGetValue(input.NativePointer, out var inView))
            {
                inView = _gpu.VideoDevice.CreateVideoProcessorInputView(input, _enumerator, new VideoProcessorInputViewDescription
                {
                    FourCC = 0,
                    ViewDimension = VideoProcessorInputViewDimension.Texture2D,
                    Texture2D = new Texture2DVideoProcessorInputView { MipSlice = 0, ArraySlice = 0 },
                });
                _inputViews[input.NativePointer] = inView;
            }
            if (!_outputViews.TryGetValue(output.NativePointer, out var outView))
            {
                outView = _gpu.VideoDevice.CreateVideoProcessorOutputView(output, _enumerator, new VideoProcessorOutputViewDescription
                {
                    ViewDimension = VideoProcessorOutputViewDimension.Texture2D,
                    Texture2D = new Texture2DVideoProcessorOutputView { MipSlice = 0 },
                });
                _outputViews[output.NativePointer] = outView;
            }
            var stream = new VideoProcessorStream { Enable = true, InputSurface = inView };
            _gpu.VideoContext.VideoProcessorBlt(_processor, outView, 0, 1, new[] { stream }).CheckError();
            // Submit now: the encoder runs on its own thread and would otherwise wait for this
            // command buffer to be flushed by something else (measured: ~40 ms -> ~3 ms per frame).
            _gpu.Context.Flush();
        }
        finally { _gpu.Unlock(); }
    }

    /// <summary>Drop cached views for a texture that is about to be released.</summary>
    public void Forget(ID3D11Texture2D texture)
    {
        if (_inputViews.Remove(texture.NativePointer, out var iv)) iv.Dispose();
        if (_outputViews.Remove(texture.NativePointer, out var ov)) ov.Dispose();
    }

    public void Dispose()
    {
        foreach (var v in _inputViews.Values) v.Dispose();
        foreach (var v in _outputViews.Values) v.Dispose();
        _inputViews.Clear();
        _outputViews.Clear();
        _processor.Dispose();
        _enumerator.Dispose();
    }
}
