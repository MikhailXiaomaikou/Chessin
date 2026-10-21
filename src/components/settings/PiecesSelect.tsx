import {
  Box,
  Combobox,
  Flex,
  Input,
  InputBase,
  ScrollArea,
  Text,
  useCombobox,
} from "@mantine/core";
import { useAtom } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { is3dAtom, PIECE_SETS_2D, PIECE_SETS_3D, pieceSetAtom } from "@/state/atoms";
import PieceComponent from "../common/Piece";

type Item = {
  label: string;
  value: string;
};

// Chessin: the lists live in src/state/atoms.ts (they also validate the stored value);
// NC / unlicensed sets were removed, see docs/THIRD_PARTY_ASSETS.md.
const pieceSets2d: Item[] = PIECE_SETS_2D.map((value) => ({
  label: value.charAt(0).toUpperCase() + value.slice(1),
  value,
}));

const pieceSets3d: Item[] = PIECE_SETS_3D.map((value) => ({ label: value, value }));

function DisplayPieces() {
  const pieces = ["rook", "knight", "bishop", "queen", "king", "pawn"] as const;
  return (
    <Flex gap="xs">
      {pieces.map((role, index) => (
        <Box key={index} h="2.5rem" w="2.5rem">
          <PieceComponent piece={{ color: "white", role }} />
        </Box>
      ))}
    </Flex>
  );
}

export default function PiecesSelect() {
  const { t } = useTranslation();
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  const [pieceSet, setPieceSet] = useAtom(pieceSetAtom);
  const [is3d] = useAtom(is3dAtom);

  const pieceSets = is3d ? pieceSets3d : pieceSets2d;

  const options = pieceSets.map((item) => (
    <Combobox.Option
      value={item.value}
      key={item.value}
      onMouseOver={() => setPieceSet(item.value)}
    >
      <Text fz="sm" fw={500}>
        {item.label}
      </Text>
    </Combobox.Option>
  ));

  const selected = pieceSets.find((p) => p.value === pieceSet);

  // Reset to default when switching modes if current value doesn't exist
  useEffect(() => {
    if (!selected && pieceSet) {
      setPieceSet(pieceSets[0].value);
    }
  }, [is3d, selected, pieceSet, pieceSets, setPieceSet]);

  return (
    <div>
      <Flex justify="space-between" align="center" gap="md">
        <DisplayPieces />
        <Combobox
          store={combobox}
          withinPortal={false}
          onOptionSubmit={(val) => {
            setPieceSet(val);
            combobox.closeDropdown();
          }}
        >
          <Combobox.Target>
            <InputBase
              component="button"
              type="button"
              pointer
              onClick={() => combobox.toggleDropdown()}
              multiline
              w="10rem"
            >
              {selected ? (
                <Text fz="sm" fw={500}>
                  {selected.label}
                </Text>
              ) : (
                <Input.Placeholder>{t("Common.PickValue")}</Input.Placeholder>
              )}
            </InputBase>
          </Combobox.Target>

          <Combobox.Dropdown>
            <Combobox.Options>
              <ScrollArea.Autosize mah={200} type="always" scrollbars="y">
                {options}
              </ScrollArea.Autosize>
            </Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
      </Flex>
    </div>
  );
}
