import sys
import json
import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from deepface import DeepFace

MODEL_PATH = "src/scripts/models/blaze_face_short_range.tflite"


def analyze_face(image_path):
    image = cv2.imread(image_path)
    image_height, image_width = image.shape[0], image.shape[1]

    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceDetectorOptions(base_options=base_options)
    detector = vision.FaceDetector.create_from_options(options)

    mp_image = mp.Image.create_from_file(image_path)
    detection_result = detector.detect(mp_image)

    # Reject if no face, or more than one face, was found
    if len(detection_result.detections) != 1:
        return {"face_found": False}

    detection = detection_result.detections[0]
    box = detection.bounding_box

    face_width_ratio = box.width / image_width
    face_height_ratio = box.height / image_height
    face_center_x = (box.origin_x + (box.width / 2)) / image_width
    face_center_y = (box.origin_y + (box.height / 2)) / image_height
    distance_from_center_x = abs(face_center_x - 0.5)
    distance_from_center_y = abs(face_center_y - 0.5)

    size_ok = face_width_ratio > 0.15 and face_height_ratio > 0.15
    centered_ok = distance_from_center_x < 0.25 and distance_from_center_y < 0.25

    no_sunglasses = check_sunglasses(image_path, detection, image_width, image_height)

    result = {
        "face_found": True,
        "size_ok": size_ok,
        "centered_ok": centered_ok,
        "no_sunglasses": no_sunglasses
    }

    # Fail-fast: only run the slow DeepFace check if the cheap checks already passed
    if size_ok and centered_ok and no_sunglasses:
        expression_result = check_expression(image_path)
        result["expression_ok"] = expression_result

    return result


def check_sunglasses(image_path, detection, image_width, image_height):
    image = cv2.imread(image_path)

    keypoints = detection.keypoints
    right_eye = keypoints[0]
    left_eye = keypoints[1]

    eyes_look_dark_and_flat = []

    for eye in [right_eye, left_eye]:
        eye_x = int(eye.x * image_width)
        eye_y = int(eye.y * image_height)

        eye_patch = get_patch(image, eye_x, eye_y, 15)
        gray_patch = cv2.cvtColor(eye_patch, cv2.COLOR_BGR2GRAY)

        avg_brightness = gray_patch.mean()
        brightness_variance = gray_patch.var()

        is_dark = avg_brightness < 50
        is_uniform = brightness_variance < 150

        eyes_look_dark_and_flat.append(is_dark and is_uniform)

    # Require BOTH eyes to look dark and flat before flagging —
    # reduces false positives from a single shadowed or partially-closed eye
    sunglasses_detected = all(eyes_look_dark_and_flat)
    return not sunglasses_detected


def get_patch(image, center_x, center_y, patch_size):
    height, width = image.shape[0], image.shape[1]
    top = max(0, center_y - patch_size)
    bottom = min(height, center_y + patch_size)
    left = max(0, center_x - patch_size)
    right = min(width, center_x + patch_size)
    return image[top:bottom, left:right]


def check_expression(image_path):
    try:
        analysis = DeepFace.analyze(
            img_path=image_path,
            actions=["emotion"],
            enforce_detection=False
        )
        dominant_emotion = analysis[0]["dominant_emotion"]
        bad_emotions = ["fear", "disgust", "angry"]
        return dominant_emotion not in bad_emotions
    except Exception as error:
        return False


def build_final_result(analysis):
    if not analysis.get("face_found"):
        return {"passed": False, "reason": "no_face_or_multiple_faces_detected"}

    if not analysis.get("size_ok"):
        return {"passed": False, "reason": "face_too_small_or_cropped"}

    if not analysis.get("centered_ok"):
        return {"passed": False, "reason": "face_not_centered"}

    if not analysis.get("no_sunglasses"):
        return {"passed": False, "reason": "possible_sunglasses_detected"}

    if not analysis.get("expression_ok"):
        return {"passed": False, "reason": "expression_check_failed"}

    return {"passed": True, "reason": None}


if __name__ == "__main__":
    image_path = sys.argv[1]
    analysis = analyze_face(image_path)
    final_result = build_final_result(analysis)
    print(json.dumps(final_result))