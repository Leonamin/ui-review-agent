import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "./goodcase/components/basic/button";
import {
  ImageViewer,
  type ViewerImage,
} from "./goodcase/components/composed/image-viewer";
import "./capture-image-viewer.css";

type CaptureImage = { id: string; url: string; label: string };

export function toViewerImage(image: CaptureImage): ViewerImage {
  return { id: image.id, src: image.url, alt: image.label || "관찰 캡처" };
}

export function CaptureImageViewer({
  images,
  initialIndex,
}: {
  images: CaptureImage[];
  initialIndex: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [index, setIndex] = useState(initialIndex);

  function handleOpenChange(isNextOpen: boolean) {
    if (isNextOpen) setIndex(initialIndex);
    setIsOpen(isNextOpen);
  }

  return (
    <ImageViewer
      images={images.map(toViewerImage)}
      index={index}
      isOpen={isOpen}
      onIndexChange={setIndex}
      onOpenChange={handleOpenChange}
      trigger={
        <Button variant="secondary" className="capture-viewer-trigger">
          <Maximize2 size={15} aria-hidden />
          크게 보기
        </Button>
      }
    />
  );
}
