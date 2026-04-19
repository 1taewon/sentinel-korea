# Task: Fix Map Colors and Layer Selection

## Research and Planning
- [x] Analyze `KoreaMap.tsx` and `App.tsx`
- [x] Check `types.ts` for data structure
- [x] Verify GeoJSON and Region Name mapping

## Implementation
- [x] Fix color transparency in `KoreaMap.tsx`
- [x] Update map coloring logic to correctly use `activeLayer` properties
- [x] Ensure `alertBySido` mapping is robust (handle name mismatches)
- [x] Fix tooltip behavior for different layers
- [x] Separate Wastewater layer into COVID-19 and Influenza
- [x] Rename and refine National Respiratory layer to "전수감시감염병(호흡기)"
- [x] Update Map and App logic for new layer states
- [x] Expandable Mini Globe for detailed Global Overlay
- [x] Region Detail: 8-week Trend Analysis Chart
- [x] AI Composite Risk Diagnosis (Signal Convergence)
- [x] Integrated Health Report for KDCA (AI + Search)
- [/] Export project to Desktop as `Sentinel pneumonia`
    - [ ] Copy source files (excluding node_modules)
    - [ ] Include all .md guides and project artifacts

## Verification
- [x] Manually verify map colors change when toggling layers
- [x] Verify colors match legend (G3=Red, G2=Orange, G1=Yellow, G0=Green)
- [x] Verify tooltip shows correct scores for active layer
- [ ] Final verification of trend chart and globe expansion in browser
