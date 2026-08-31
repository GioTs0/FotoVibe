import io
import warnings

from fastapi import HTTPException
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

register_heif_opener(thumbnails=False)
MAX_PIXELS = 64_000_000
MAX_BYTES = 25 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
    "HEIF": ("image/heic", "heic"),
}


def derivatives(raw: bytes):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in FORMATS:
                    raise HTTPException(415, "Bitte ein JPEG-, PNG-, WebP- oder HEIC-Foto wählen.")
                content_type, extension = FORMATS[source.format]
                if source.width * source.height > MAX_PIXELS:
                    raise HTTPException(413, "Dieses Foto hat mehr als 64 Megapixel.")
                if source.format in {"WEBP", "PNG"} and getattr(source, "is_animated", False):
                    raise HTTPException(415, "Bitte ein einzelnes Foto ohne Animation wählen.")
                source.load()
                ImageOps.exif_transpose(source, in_place=True)
                width, height = source.size
                source.thumbnail((2560, 2560), Image.Resampling.LANCZOS, reducing_gap=3)
                if source.info.get("icc_profile"):
                    try:
                        source = ImageCms.profileToProfile(
                            source,
                            io.BytesIO(source.info["icc_profile"]),
                            ImageCms.createProfile("sRGB"),
                            outputMode="RGB",
                        )
                    except (ImageCms.PyCMSError, ValueError, OSError):
                        pass
                # Fresh pixels intentionally exclude EXIF, GPS and other source metadata.
                clean = Image.new("RGB", source.size, (247, 246, 242))
                if "A" in source.getbands() or "transparency" in source.info:
                    rgba = source.convert("RGBA")
                    clean.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    clean.paste(source.convert("RGB"))
                display = io.BytesIO()
                clean.save(display, "JPEG", quality=88, optimize=True)
                clean.thumbnail((640, 640), Image.Resampling.LANCZOS)
                thumb = io.BytesIO()
                clean.save(thumb, "JPEG", quality=82, optimize=True)
                return {
                    "content_type": content_type,
                    "extension": extension,
                    "width": width,
                    "height": height,
                    "display": display.getvalue(),
                    "thumb": thumb.getvalue(),
                }
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(413, "Dieses Foto hat mehr als 64 Megapixel.") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise HTTPException(
            415, "Dieses Bild konnte nicht gelesen werden. Bitte ein anderes wählen."
        ) from None
