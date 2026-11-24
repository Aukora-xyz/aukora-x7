"""Print the complete wire bytes of one conformance vector as hex."""
import argparse
import gzip
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("group", choices=["matrix", "length", "history", "signed", "gate"])
parser.add_argument("label")
args = parser.parse_args()
vectors = Path(__file__).resolve().parents[1] / "vectors"
with gzip.open(vectors / (args.group + ".bin.gz"), "rb") as frames:
    for row in (vectors / (args.group + ".tsv")).read_text().splitlines():
        label, width, verdict, head = row.split("\t")
        size = int(width)
        frame = frames.read(size)
        if len(frame) != size:
            raise ValueError("truncated vector stream")
        if label == args.label:
            print(frame.hex())
            break
    else:
        parser.error("label absent from the group's manifest")
