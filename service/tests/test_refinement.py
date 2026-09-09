from service.src.refinement import _parse_object_vocabulary


def test_vlm_vocabulary_parser_accepts_json_and_removes_duplicates() -> None:
    assert _parse_object_vocabulary('["Person", "keyboard", "person"]') == (
        "person",
        "keyboard",
    )


def test_vlm_vocabulary_parser_removes_reasoning_and_prefixes() -> None:
    assert _parse_object_vocabulary(
        "<think>inspect the scene</think>Objects: person, cup, monitor"
    ) == ("person", "cup", "monitor")
