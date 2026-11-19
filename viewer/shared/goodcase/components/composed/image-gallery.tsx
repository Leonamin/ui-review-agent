import { useRef, useState } from "react";
import { Button } from "../basic/button";
import { ImageViewer, type ViewerImage } from "./image-viewer";
import { GalleryImage } from "./gallery-image";

export function ImageGallery({
  images,
  className,
  label = "이미지 갤러리",
}: {
  images: ViewerImage[];
  className?: string;
  label?: string;
}) {
  const [index, setIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className={className}>
      <div className="gc-image-gallery" role="group" aria-label={label}>
        {images.map((item, imageIndex) => (
          <Button
            className="gc-gallery-item"
            key={item.id}
            variant="secondary"
            aria-label={`${item.alt} 크게 보기`}
            aria-haspopup="dialog"
            onClick={(e) => {
              triggerRef.current = e.currentTarget;
              setIndex(imageIndex);
              setIsOpen(true);
            }}
          >
            <GalleryImage item={item} />
            <span>{item.alt}</span>
          </Button>
        ))}
      </div>
      <ImageViewer
        images={images}
        index={index}
        onIndexChange={setIndex}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}
